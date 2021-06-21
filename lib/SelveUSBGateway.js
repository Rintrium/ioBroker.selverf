"use strict";

const SerialPort = require("serialport");
const events = require("events");


class SelveUSBGateway {


	constructor(adapter) {

		this.adapter = adapter;
		this.eventEmitter = new events.EventEmitter();
		this.connectionEstablished = false;

	}

	methode1() { this.adapter.log.info("1");}

	ConnectUSBGateway()
	{
		this.adapter.connected = false;
		this.connectionEstablished = false;

		try {
			this.gatewayPort = new SerialPort(this.adapter.config.usbGatewayPath, { baudRate: 115200 }, this.ConnectionResultHandler.bind(this));

		} catch (error) {
			this.adapter.log.error("Invalid port: " + this.adapter.config.usbGatewayPath + "; Error: " + error);
			
			//Try again in 5 seconds
			this.reconnectTimeout = setTimeout(() => {
				this.ConnectUSBGateway();
			}, 5000);
		}

	}

	ConnectionResultHandler(error)
	{
		if (error != null)
		{
			//There was an error; Try again in 5 seconds

			this.adapter.log.info("Connection result handler wird ausgeführt! " + error);
			this.reconnectTimeout = setTimeout(() => {
				this.ConnectUSBGateway();
			}, 5000);

		}
		else
		{
			this.gatewayPort.setEncoding("utf8");
			this.gatewayPort.on("data", this.DataArrived.bind(this));
			this.gatewayPort.on("error", this.ErrorHandler.bind(this));

			// Test Paket an Gateway senden
			this.adapter.log.info("Serialport connection established. Testing connection with gateway.");
			this.gatewayPort.write("<methodCall><methodName>selve.GW.service.ping</methodName></methodCall>");
		}
	}

	Unload()
	{
		clearTimeout(this.reconnectTimeout);
	}

	DataArrived(data)
	{
		this.adapter.log.info("Habe Daten erhalten:" + data);
	}

	WriteData(data)
	{
		this.gatewayPort.write(data, "utf8", this.ErrorHandler.bind(this));
	}

	ErrorHandler(error)
	{
		this.adapter.log.console.error("Serialport Errorhandler: " + error);
	}


}

module.exports = SelveUSBGateway;