import axios, { Method as AxiosMethod, AxiosResponse } from "axios";
import fs from "fs";
import cookie from "cookie";
import diff from "fast-array-diff";
import {
	API,
	APIEvent,
	Categories,
	CharacteristicEventTypes,
	CharacteristicGetCallback,
	CharacteristicSetCallback,
	CharacteristicValue,
	DynamicPlatformPlugin,
	HAP,
	Logging,
	PlatformAccessory,
	PlatformAccessoryEvent,
	PlatformConfig,
} from "homebridge";
import {
	APIValue,
	CommandClassIds,
	DataAPIReponse,
	MeterCommandClass,
	PumpOutlet,
	SwitchBinaryCommandClass,
	ZWayPumpOutletConfig,
} from "./types";

const PLUGIN_NAME = "homebridge-zway-pump-outlet";
const PLATFORM_NAME = "zway-pump-outlet";

let hap: HAP;
let Accessory: typeof PlatformAccessory;

export = (api: API) => {
	hap = api.hap;
	Accessory = api.platformAccessory;

	api.registerPlatform(PLATFORM_NAME, ZWayPumpOutlet);
};

const ANTI_STARTUP_FLOOD_COUNT = 120;

class ZWayPumpOutlet implements DynamicPlatformPlugin {
	protected readonly log: Logging;
	protected readonly api: API;

	protected readonly accessories: Record<number, PlatformAccessory> = {};

	protected pollTimeout: NodeJS.Timeout = setTimeout(() => null, 0);

	protected config: {
		host: string;
		user: string;
		pass: string;
		nuke: boolean;
		ignore: number[];
		toPoll: number[];
		thresholdWattage: number;
	};

	protected session: string | null = null;
	protected pumps: Record<number, PumpOutlet> = {};

	protected pendingQueries: Record<string, number> = {};

	protected numPolls = 0; // prevent flooding on launch

	constructor(log: Logging, config: PlatformConfig, api: API) {
		this.log = log;
		this.api = api;

		this.config = {
			host: (config as ZWayPumpOutletConfig).host,
			user: (config as ZWayPumpOutletConfig).user,
			pass: (config as ZWayPumpOutletConfig).pass,
			nuke: (config as ZWayPumpOutletConfig).nuke !== undefined,
			ignore:
				(config as ZWayPumpOutletConfig).ignore === undefined
					? []
					: (config as ZWayPumpOutletConfig).ignore,
			toPoll:
				(config as ZWayPumpOutletConfig).toPoll === undefined
					? []
					: (config as ZWayPumpOutletConfig).toPoll,
			thresholdWattage: (config as ZWayPumpOutletConfig).thresholdWattage,
		};

		log.info("Finished initializing!");

		/*
		 * When this event is fired, homebridge restored all cached accessories from disk and did call their respective
		 * `configureAccessory` method for all of them. Dynamic Platform plugins should only register new accessories
		 * after this event was fired, in order to ensure they weren't added to homebridge already.
		 * This event can also be used to start discovery of new accessories.
		 */
		api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
			log.info("Finished launching");

			await this.initialContact();

			let delta = diff.diff(Object.keys(this.accessories), Object.keys(this.pumps));
			if (this.config.nuke) {
				log.warn("NUKING");
				delta = diff.diff(Object.keys(this.accessories), []);
			}

			delta.added.forEach((nodeKey) => {
				const nodeId = parseInt(nodeKey);

				if (config.ignore.includes(nodeId)) {
					this.log("Ignoring #" + nodeId);
					return;
				}

				this.log("Creating accessory for outlet #" + nodeId);

				let name = this.pumps[nodeId].lastState.data.givenName.value as string;
				if (name == "") {
					this.log.warn("This device does not have a name set in Z-Way.  Defaulting to Pump");
					name = "Pump";
				}

				const uuid = hap.uuid.generate(nodeKey);
				const accessory = new Accessory(name, uuid, Categories.FAUCET);
				accessory.context.nodeId = nodeId;
				accessory.context.isOn = false;
				accessory.context.isEmpty = false;
				accessory.context.lastPowerChange = 0;

				accessory.addService(hap.Service.Valve, name);
				accessory.addService(hap.Service.LeakSensor, name);

				this.configureAccessory(accessory);
				this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
			});
			delta.removed.forEach((nodeKey) => {
				const nodeId = parseInt(nodeKey);

				this.log("Pump #" + nodeId + " removed");

				this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
					this.accessories[nodeId],
				]);

				delete this.accessories[nodeId];
			});

			this.updateValues();

			this.pollTimeout = setTimeout(this.poll.bind(this), 500);
		});
	}

	/*
	 * This function is invoked when homebridge restores cached accessories from disk at startup.
	 * It should be used to setup event handlers for characteristics and update respective values.
	 */
	configureAccessory(accessory: PlatformAccessory): void {
		this.log(
			`Configuring accessory ${accessory.displayName} with node ID ${accessory.context.nodeId}`,
		);

		accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
			this.log(`#${accessory.context.nodeId} identified!`);
		});

		const valveService = accessory.getService(hap.Service.Valve)!;
		valveService
			.getCharacteristic(hap.Characteristic.Active)
			.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
				callback(null, accessory.context.isOn);
			})
			.on(
				CharacteristicEventTypes.SET,
				(value: CharacteristicValue, callback: CharacteristicSetCallback) => {
					this.log("Setting #" + accessory.context.nodeId + " to " + value);
					accessory.context.lastPowerChange = new Date().getTime();
					this.makeRequest(
						"POST",
						"Run/devices[" +
							accessory.context.nodeId +
							"].instances[0].commandClasses[" +
							CommandClassIds.SwitchBinary +
							"].Set(" +
							(value ? 255 : 0) +
							")",
						{},
						"ZWave.zway",
					);
					callback(null, value);
				},
			);
		valveService
			.getCharacteristic(hap.Characteristic.InUse)
			.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
				callback(null, accessory.context.isOn);
			});
		valveService
			.getCharacteristic(hap.Characteristic.ValveType)
			.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
				callback(null, 0); // generic
			})
			.updateValue(0);

		const leakSensorService = accessory.getService(hap.Service.LeakSensor)!;
		leakSensorService
			.getCharacteristic(hap.Characteristic.LeakDetected)
			.on(CharacteristicEventTypes.GET, (callback: CharacteristicSetCallback) => {
				callback(null, accessory.context.isEmpty);
			});

		this.accessories[accessory.context.nodeId] = accessory;
	}

	// --------------------------- CUSTOM METHODS ---------------------------

	protected async initialContact(): Promise<void> {
		this.log("Sending initial request to enumerate devices...");
		const response = await this.getData();

		this.log(`Your controller appears to be a ${response.data.controller.data.vendor.value}!`);

		Object.keys(response.data.devices).forEach((nodeId) => {
			const device = response.data.devices[nodeId];
			this.log(
				`Found #${nodeId}:`,
				`${device.data.givenName.value}`,
				`(${device.data.vendorString.value}`,
				`${device.data.deviceTypeString.value})`,
			);

			if (this.config.ignore.includes(parseInt(nodeId))) {
				this.log("Ignoring");
				return;
			}

			if (
				device.data.vendorString.value == "Elexa Consumer Products Inc." &&
				device.data.deviceTypeString.value == "Binary Power Switch"
			) {
				this.log("Identified this as an outlet to be served by this platform");
			} else {
				return;
			}

			const pump: PumpOutlet = {
				nodeId: parseInt(nodeId),
				lastState: device,
			};

			this.pumps[parseInt(nodeId)] = pump;
		});
	}

	// eslint-disable-next-line
	protected async makeRequest<T = any>(
		method: AxiosMethod,
		url: string,
		data: Record<string, unknown> = {},
		base = "ZAutomation/api/v1",
	): Promise<AxiosResponse<T>> {
		if (this.session == null) {
			this.log("No requests have been made so far, looking for a session.");
			try {
				const fileContents = fs.readFileSync(
					this.api.user.storagePath() + "/." + PLUGIN_NAME + "-token",
					{
						encoding: "utf8",
					},
				);
				const parsedFile = JSON.parse(fileContents);
				const session = parsedFile.session;
				this.session = session;

				this.log(`Got session ${session.substring(0, 6)}...`);
				this.log("Testing access");

				await axios({
					method: "GET",
					url: "status",
					data: JSON.stringify({}),

					baseURL: this.config.host + "ZAutomation/api/v1",
					withCredentials: true,
					responseType: "json",
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "Homebridge " + PLATFORM_NAME,
						"Cookie": "ZWAYSession=" + session,
						"ZWAYSession": session,
					},
				});

				this.log("Success, session is valid!  Good to go!");
			} catch (e) {
				await this.makeNewLoginSession();
			}
		}
		return await axios({
			method: method,
			url: url,
			data: JSON.stringify(data),

			baseURL: this.config.host + base,
			withCredentials: true,
			responseType: "json",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "Homebridge " + PLATFORM_NAME,
				"Cookie": "ZWAYSession=" + this.session,
				"ZWAYSession": this.session,
			},
		});
	}

	protected getData(): Promise<AxiosResponse<DataAPIReponse>> {
		return this.makeRequest<DataAPIReponse>("GET", "Data/0", {}, "ZWaveAPI");
	}

	protected async makeNewLoginSession(): Promise<void> {
		this.log("No session exists or session is invalid.  Trying to login");
		const response = await axios({
			method: "POST",
			url: "login",
			data: JSON.stringify({
				login: this.config.user,
				password: this.config.pass,
			}),

			baseURL: this.config.host + "ZAutomation/api/v1",
			withCredentials: true,
			responseType: "json",
			validateStatus: () => true,
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "Homebridge " + PLATFORM_NAME,
			},
		});

		this.log(`Got a response ${response.status} (${response.statusText})`);

		if (response.status != 200) {
			this.log("This appears to be an error.  Please check your login information.");
			return;
		}

		this.log("Parsing cookie header(s)");
		const parsedCookie = cookie.parse(response.headers["set-cookie"][0]);
		const session = parsedCookie.ZWAYSession;
		this.session = session;
		const userId = response.data.data.id;

		this.log(`Got session ${session.substr(0, 6)}..., saving`);
		fs.writeFileSync(
			this.api.user.storagePath() + "/." + PLUGIN_NAME + "-token",
			JSON.stringify({
				session,
			}),
		);

		this.log("Trying to set session as non-expiring...");
		const extendExpiryResponse = await axios({
			method: "PUT",
			url: "profiles/" + userId + "/token/" + session.substr(0, 6) + "...",
			data: JSON.stringify({}),

			baseURL: this.config.host + "ZAutomation/api/v1",
			withCredentials: true,
			responseType: "json",
			validateStatus: () => true,
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "Homebridge " + PLATFORM_NAME,
				"Cookie": "ZWAYSession=" + session,
				"ZWAYSession": session,
			},
		});

		if (extendExpiryResponse.status < 300) {
			this.log("Success");
			this.log(
				"If you would like, you can remove your password from the config file (set it to an empty string)",
			);
		} else {
			this.log("Unable to set as non-expiring.");
			this.log(
				"This platform may stop working or experience delays when needing to re-authenticate",
			);
		}
	}

	protected updateValues(): void {
		Object.values(this.accessories).forEach((accessory) => {
			const pump = this.pumps[accessory.context.nodeId];
			const valveService = accessory.getService(hap.Service.Valve)!;
			const leakSensorService = accessory.getService(hap.Service.LeakSensor)!;

			const classes = pump.lastState.instances[0].commandClasses;
			const switchClass = classes[CommandClassIds.SwitchBinary]! as SwitchBinaryCommandClass;
			const meterClass = classes[CommandClassIds.Meter]! as MeterCommandClass;

			// power is on
			if (switchClass.data.level.value) {
				accessory.context.isOn = switchClass.data.level.value;

				if (new Date().getTime() - accessory.context.lastPowerChange < 30000) {
					this.log.info("Waiting to trigger empty so switch state power can propogate");
					accessory.context.isEmpty = false;
				} else {
					accessory.context.isEmpty = meterClass.data[2].val.value < this.config.thresholdWattage;
				}
			} else {
				accessory.context.isOn = switchClass.data.level.value;
			}
			valveService.getCharacteristic(hap.Characteristic.Active).updateValue(accessory.context.isOn);
			valveService.getCharacteristic(hap.Characteristic.InUse).updateValue(accessory.context.isOn);
			leakSensorService
				.getCharacteristic(hap.Characteristic.LeakDetected)
				.updateValue(accessory.context.isEmpty);

			if (accessory.context.isOn && accessory.context.isEmpty) {
				this.log.warn("Shutting off " + accessory.context.nodeId);
				accessory.context.lastPowerChange = new Date().getTime();
				this.makeRequest(
					"POST",
					"Run/devices[" +
						accessory.context.nodeId +
						"].instances[0].commandClasses[" +
						CommandClassIds.SwitchBinary +
						"].Set(" +
						0 +
						")",
					{},
					"ZWave.zway",
				);
			}
		});
	}

	// async and on a timeout instead of an interval so it will not bunch up on delayed requests
	protected async poll(): Promise<void> {
		if (this.numPolls < ANTI_STARTUP_FLOOD_COUNT) this.numPolls++;
		if (this.numPolls == ANTI_STARTUP_FLOOD_COUNT) {
			this.log("Startup anti-flood is finished");
			this.numPolls = 999;
		}

		const response = await this.getData();

		Object.keys(this.pumps).forEach((nodeKey) => {
			this.pumps[parseInt(nodeKey)].lastState = response.data.devices[nodeKey];
		});

		const requestsToDispatch: {
			device: number;
			instance: number;
			commandClass: number;
			param: string;
			time: number;
		}[] = [];

		const currentTime = response.data.updateTime;

		Object.values(this.pumps).forEach((pump) => {
			if (!this.config.toPoll.includes(pump.nodeId)) {
				return;
			}

			this.log.warn(
				"Use lifeline group and/or update parameter 2 to increase reporting delta instead of polling.",
			);
		});

		requestsToDispatch.forEach((request) => {
			const pendingQueryKey = JSON.stringify({
				device: request.device,
				instance: request.instance,
				commandClass: request.commandClass,
				param: request.param,
			});
			// give 120 cycles (60s) to catch up initially
			if (this.numPolls > 1 && this.numPolls < ANTI_STARTUP_FLOOD_COUNT) {
				return;
			}
			// this one already exists in pending pile
			if (this.pendingQueries[pendingQueryKey] >= request.time) {
				if (currentTime - this.pendingQueries[pendingQueryKey] >= 100) {
					this.log("This request has been waiting over 100 seconds with no update, retrying");
				} else {
					return; // already waiting
				}
			}
			this.pendingQueries[pendingQueryKey] = currentTime;
			this.log("Querying " + JSON.stringify(request));
			this.makeRequest(
				"POST",
				"Run/devices[" +
					request.device +
					"].instances[" +
					request.instance +
					"].commandClasses[" +
					request.commandClass +
					"].Get(" +
					request.param +
					")",
				{},
				"ZWave.zway",
			);
		});

		this.updateValues();

		this.pollTimeout = setTimeout(this.poll.bind(this), 500);
	}
}
