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
	PumpOutlet,
	CommandClassIds,
	DataAPIReponse,
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

// seconds
const UPDATE_TOLERANCES = {
	// doorLock: 600,
	// battery: 86400, // 1 day
	// configuration: 86400,
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

				// const uuid = hap.uuid.generate(nodeKey);
				// const accessory = new Accessory(name, uuid, Categories.DOOR_LOCK);
				// accessory.context.nodeId = nodeId;
				// accessory.context.battery = -1;
				// accessory.context.lastConfigurationUpdate = 0;
				// accessory.context.lastLockState = hap.Characteristic.LockTargetState.UNSECURED;
				// accessory.context.targetLockState = hap.Characteristic.LockTargetState.UNSECURED;
				// accessory.context.configurationOptions = {};
				// Object.keys(ConfigurationOptions).forEach((name) => {
				// 	accessory.context.configurationOptions[name] = 0;
				// });

				// accessory.addService(hap.Service.LockMechanism, name);
				// accessory.addService(hap.Service.LockManagement, name);
				// accessory.addService(hap.Service.BatteryService, "Battery");

				// this.configureAccessory(accessory);
				// this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
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

		// const mechanismService = accessory.getService(hap.Service.LockMechanism)!;
		// mechanismService
		// 	.getCharacteristic(hap.Characteristic.LockCurrentState)
		// 	.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
		// 		callback(null, accessory.context.lastLockState);
		// 	});
		// mechanismService
		// 	.getCharacteristic(hap.Characteristic.LockTargetState)
		// 	.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
		// 		callback(null, accessory.context.targetLockState);
		// 	})
		// 	.on(
		// 		CharacteristicEventTypes.SET,
		// 		(value: CharacteristicValue, callback: CharacteristicSetCallback) => {
		// 			accessory.context.targetLockState = value;

		// 			let zWaveSet;
		// 			if (value == hap.Characteristic.LockTargetState.SECURED) {
		// 				zWaveSet = 255;
		// 			} else {
		// 				zWaveSet = 0;
		// 			}
		// 			this.log("Setting #" + accessory.context.nodeId + " to " + zWaveSet);
		// 			this.makeRequest(
		// 				"POST",
		// 				"Run/devices[" +
		// 					accessory.context.nodeId +
		// 					"].instances[" +
		// 					this.pumps[accessory.context.nodeId].commandClasses.doorLock.instance +
		// 					"].commandClasses[" +
		// 					CommandClassIds.DoorLock +
		// 					"].Set(" +
		// 					zWaveSet +
		// 					")",
		// 				{},
		// 				"ZWave.zway",
		// 			);
		// 			callback(null, value);
		// 		},
		// 	);

		// const managementService = accessory.getService(hap.Service.LockManagement)!;
		// managementService
		// 	.getCharacteristic(hap.Characteristic.LockControlPoint)
		// 	.on(
		// 		CharacteristicEventTypes.SET,
		// 		(value: CharacteristicValue, callback: CharacteristicSetCallback) => {
		// 			this.log.info("Tried writing to management service: " + value);
		// 			callback(new Error("Does nothing"));
		// 		},
		// 	);
		// managementService
		// 	.getCharacteristic(hap.Characteristic.Version)
		// 	.updateValue("1.0")
		// 	.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
		// 		callback(null, "1.0");
		// 	});
		// managementService
		// 	.getCharacteristic(hap.Characteristic.AudioFeedback)
		// 	.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
		// 		callback(null, accessory.context.configurationOptions.Beeper);
		// 	})
		// 	.on(
		// 		CharacteristicEventTypes.SET,
		// 		(value: CharacteristicValue, callback: CharacteristicSetCallback) => {
		// 			const param = value
		// 				? "" + ConfigurationOptions.Beeper + ",255,0"
		// 				: "" + ConfigurationOptions.Beeper + ",0,0";
		// 			this.makeRequest(
		// 				"POST",
		// 				"Run/devices[" +
		// 					accessory.context.nodeId +
		// 					"].instances[" +
		// 					this.pumps[accessory.context.nodeId].commandClasses.configuration.instance +
		// 					"].commandClasses[" +
		// 					CommandClassIds.Configuration +
		// 					"].Set(" +
		// 					param +
		// 					")",
		// 				{},
		// 				"ZWave.zway",
		// 			);
		// 			callback(null, value);
		// 		},
		// 	);

		// const batteryService = accessory.getService(hap.Service.BatteryService)!;
		// batteryService
		// 	.getCharacteristic(hap.Characteristic.BatteryLevel)
		// 	.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
		// 		callback(null, accessory.context.battery);
		// 	});
		// batteryService
		// 	.getCharacteristic(hap.Characteristic.ChargingState)
		// 	.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
		// 		callback(null, hap.Characteristic.ChargingState.NOT_CHARGEABLE);
		// 	})
		// 	.updateValue(hap.Characteristic.ChargingState.NOT_CHARGEABLE);
		// batteryService
		// 	.getCharacteristic(hap.Characteristic.StatusLowBattery)
		// 	.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
		// 		callback(null, accessory.context.battery <= 60);
		// 	});

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
			// const mechanismService = accessory.getService(hap.Service.LockMechanism)!;

			// const classes =
			// 	lock.lastState.instances[lock.commandClasses.doorLock.instance].commandClasses;
			// const doorLockClass = classes[CommandClassIds.DoorLock]! as DoorLockCommandClass;

			// // lock changed states
			// if (
			// 	accessory.context.lastLockState != this.toLockStateCharacteristic(doorLockClass.data.mode)
			// ) {
			// 	this.log("Lock " + accessory.displayName + " changed states!");
			// 	accessory.context.lastLockState = this.toLockStateCharacteristic(doorLockClass.data.mode);
			// 	accessory.context.targetLockState = this.toLockStateCharacteristic(doorLockClass.data.mode);
			// }
			// mechanismService
			// 	.getCharacteristic(hap.Characteristic.LockCurrentState)
			// 	.updateValue(accessory.context.lastLockState);
			// mechanismService
			// 	.getCharacteristic(hap.Characteristic.LockTargetState)
			// 	.updateValue(accessory.context.targetLockState);

			// const managementService = accessory.getService(hap.Service.LockManagement)!;

			// const configurationClass = classes[CommandClassIds.DoorLock]! as ConfigurationCommandClass;
			// if (configurationClass.data["3"] !== undefined) {
			// 	accessory.context.configurationOptions.Beeper = configurationClass.data["3"].value == 255;
			// 	managementService
			// 		.getCharacteristic(hap.Characteristic.AudioFeedback)
			// 		.updateValue(accessory.context.configurationOptions.Beeper);
			// }

			// // not user-accessible as it resets the code length
			// // which locks everyone out even after it is disabled
			// if (configurationClass.data["4"] !== undefined) {
			// 	accessory.context.configurationOptions.VacationMode =
			// 		configurationClass.data["4"].value == 255;
			// }

			// accessory.context.battery = classes[CommandClassIds.Battery]!.data.last.value;

			// const batteryService = accessory.getService(hap.Service.BatteryService)!;
			// batteryService
			// 	.getCharacteristic(hap.Characteristic.BatteryLevel)
			// 	.updateValue(accessory.context.battery);
			// batteryService
			// 	.getCharacteristic(hap.Characteristic.StatusLowBattery)
			// 	.updateValue(accessory.context.battery <= 60);
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
			// if (
			// 	currentTime - this.accessories[lock.nodeId].context.lastConfigurationUpdate >
			// 	UPDATE_TOLERANCES.configuration
			// ) {
			// 	Object.keys(ConfigurationOptions).forEach((name) => {
			// 		requestsToDispatch.push({
			// 			device: lock.nodeId,
			// 			instance: lock.commandClasses.configuration.instance,
			// 			commandClass: parseInt(CommandClassIds.Configuration as string),
			// 			time: this.accessories[lock.nodeId].context.lastConfigurationUpdate,
			// 			param: ConfigurationOptions[name].toString(),
			// 		});
			// 	});
			// 	this.accessories[lock.nodeId].context.lastConfigurationUpdate = currentTime;
			// }
			// const batteryTime = lock.lastState.instances[lock.commandClasses.battery.instance]
			// 	.commandClasses[CommandClassIds.Battery]!;
			// if (currentTime - batteryTime.data.last.updateTime > UPDATE_TOLERANCES.battery) {
			// 	requestsToDispatch.push({
			// 		device: lock.nodeId,
			// 		instance: lock.commandClasses.battery.instance,
			// 		commandClass: parseInt(CommandClassIds.Battery as string),
			// 		time: batteryTime.data.last.updateTime,
			// 		param: "",
			// 	});
			// }

			// const lockTime = lock.lastState.instances[lock.commandClasses.doorLock.instance]
			// 	.commandClasses[CommandClassIds.DoorLock]! as DoorLockCommandClass;
			// if (currentTime - lockTime.data.mode.updateTime > UPDATE_TOLERANCES.doorLock) {
			// 	requestsToDispatch.push({
			// 		device: lock.nodeId,
			// 		instance: lock.commandClasses.doorLock.instance,
			// 		commandClass: parseInt(CommandClassIds.DoorLock as string),
			// 		time: lockTime.data.mode.updateTime,
			// 		param: "",
			// 	});
			// }
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
