"use strict";

const SerialPort = require("serialport");
const events = require("events");
const xml2js  = require ("xml2js");
const { util } = require("chai");


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

	async ConnectionResultHandler(error)
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
			await this.InitializeGatewayStates();

			this.gatewayPort.setEncoding("utf8");
			this.gatewayPort.on("data", this.DataArrived.bind(this));
			this.gatewayPort.on("error", this.ErrorHandler.bind(this));


			// Test Paket an Gateway senden
			this.adapter.log.info("Serialport connection established. Testing connection with gateway.");
			this.partialMessage = "";
			this.gatewayPort.write("<methodCall><methodName>selve.GW.service.ping</methodName></methodCall>");
		}
	}

	async InitializeGatewayStates()
	{
		await this.adapter.setObjectNotExistsAsync("Gateway.DutyCycleOccupancyRate", {
			type: "state",
			common: {
				name: "DutyCycleOccupancyRate",
				type: "number",
				role: "value",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.adapter.setObjectNotExistsAsync("Gateway.Mode", {
			type: "state",
			common: {
				name: "Mode",
				type: "number",
				role: "value",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.log.info("State wurde angelegt");
	}

	Unload()
	{
		// @ts-ignore
		clearTimeout(this.reconnectTimeout);
	}

	DataArrived(data)
	{
		//TODO: Mehrere gleichzeitig angekommene Nachrichten verarbeiten können

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

	async ProcessGatewayMessage(data)
	{
		this.adapter.log.info(JSON.stringify(data));
		this.adapter.log.info(data);

		if (data.methodResponse != null)
		{ //There is a message response
			this.adapter.log.info("Message Response from gateway");

			this.adapter.log.info(data.methodResponse.array[0].string);

		}
		else if (data.methodCall != null)
		{
			if (data.methodCall.methodName == "selve.GW.event.dutyCycle")
			{
				await this.adapter.setStateAsync("Gateway.Mode", { val: data.methodCall.array.int[0], ack: true });
				await this.adapter.setStateAsync("Gateway.DutyCycleOccupancyRate", { val: data.methodCall.array.int[1], ack: true });
			}
		}
		else {this.ErrorHandler(new Error("unknown message from Gateway: " + JSON.stringify(data)));}
	}


}

module.exports = SelveUSBGateway;