# homebridge-zway-pump-outlet

A homebridge plugin to interact with a Z-Way server.  As part of my hydroponics system, I wanted to be able to sense whether or not the pump had ran out of water based on the power flowing through a smart outlet.  Therefore, this exposes both Valve and Leak Sensor (for when out of water) services.

## My Setup
In my personal usage, I used a [RaZberry](https://smile.amazon.com/dp/B01M3Q764U/) on a Pi I had laying around.

The switch I used was a Dome DMOF1 outlet and the pump a [Beckett 430 GPH Fountain Pump](https://www.homedepot.com/p/Beckett-430-GPH-Submersible-Fountain-Pump-M400HD/100083846).  I found that about 14 watts were used when the pump was in normal use and around 7 watts when it was running dry.

## Installation
Install this plugin using `npm i -g homebridge-zway-pump-outlet`.

Update the `config.json` file of your Homebridge setup to support this platform as described in the [Configuration](#configuration) section.

## Updating
Update to the latest release of this plugin using `npm i -g homebridge-zway-pump-outlet`.

## Configurations
Add the following to the Homebridge `config.json`:

```json5
{
    ...
    "platforms": [
        ...
        {
            "platform": "zway-pump-outlet",
            "host": "http://your.host.here:port/",
            "user": "admin",
            "pass": "your-password-here",
            "ignore": [ nodes, to, ignore ],
            "toPoll": [ nodes, to, poll ],
            "thresholdWattage": 10
        }
        ...
    ]
    ...
}
```

#### Parameters
* `host`: the IP/hostname of your Z-Way server and its port.  Be sure to add a trailing slash
* `user`: the username for the Z-Way instance
* `pass`: the password for the Z-Way instance
* `ignore`: Schlage lock nodes to ignore
* `toPoll`: nodes which should be polled for new information (e.g. association/lifeline is broken)
* `thresholdWattage`: below this value is considered dry and above is considered normal.
