"use strict";

const SerialPort = require("serialport");
const events = require("events");
const xml2js  = require ("xml2js");


class SelveUSBGateway {


	constructor(adapter) {

		this.adapter = adapter;
		this.eventEmitter = new events.EventEmitter();
		this.connectionEstablished = false;

	}


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
			this.partialMessage = "";
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
		this.partialMessage = this.partialMessage + data;
		//Gateway data always has to end with </methodCall> or </methodResponse>
		const trimmedMessage = this.partialMessage.trimEnd();
		this.adapter.log.info("Trimmed: " + trimmedMessage);
		if (trimmedMessage.endsWith("</methodCall>") || trimmedMessage.endsWith("</methodResponse>"))
		{
			this.adapter.log.info("complete data");
			//The data is complete and can be parsed; add old partial Messages before parsing
			xml2js.parseStringPromise(trimmedMessage).then(this.ProcessGatewayMessage.bind(this)).catch(this.ErrorHandler.bind(this));
			this.partialMessage = "";
		}
		else
		{
			this.adapter.log.info("chaining data");
			//Angekommene Teilnachrichten wurden verkettet
		}
	}

	WriteData(data)
	{
		this.gatewayPort.write(data, "utf8", this.ErrorHandler.bind(this));
	}

	ErrorHandler(error)
	{
		this.adapter.log.console.error("Serialport Errorhandler: " + error);
	}

	ProcessGatewayMessage(data)
	{
		this.adapter.log.info(JSON.stringify(data));
	}


}

module.exports = SelveUSBGateway;