"use strict";

const SerialPort = require("serialport");
const events = require("events");
const { util } = require("chai");

const xml2js = require("xml2js");
const base64 = require("base-64");
const BitSet = require("bitset");
const { clearTimeout } = require("timers");



class SelveUSBGateway {


	constructor(adapter) {

		this.adapter = adapter;
		this.eventEmitter = new events.EventEmitter();
		this.connectionEstablished = false;
		this.awaitingResponse = false;
		this.delayedMessages = new Array();
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
			this.Ping();
			this.WriteData("<methodCall><methodName>selve.GW.device.getIDs</methodName></methodCall>");
			
			
			
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
			xml2js.parseStringPromise(trimmedMessage, {tagValueProcessor : a => {
				if (Array.isArray(a)) return a.join(",");
				return a;
			}}).then(this.ProcessGatewayMessage.bind(this)).catch(this.ErrorHandler.bind(this));
			//this.ProcessGatewayMessage(convert.xml2js(data, {compact: false}));
			//this.ProcessGatewayMessage(this.ParseGatewayData(trimmedMessage));
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
		if (this.awaitingResponse)
		{
			this.delayedMessages.push(data);
		}
		else
		{
			this.gatewayPort.write(data, "utf8", this.ErrorHandler.bind(this));
			this.gatewayPort.drain();
			this.awaitingResponse = true;

			clearTimeout(this.connectionTimeout);
			this.connectionTimeout = setTimeout(this.LostConnectionHandler.bind(this), 5000);
		}
	}

	WriteDelayedData()
	{
		if (this.delayedMessages.length > 0)
		{
			this.gatewayPort.write(this.delayedMessages.shift(), "utf8", this.ErrorHandler.bind(this));
			this.gatewayPort.drain();

			clearTimeout(this.connectionTimeout);
			this.connectionTimeout = setTimeout(this.LostConnectionHandler.bind(this), 5000);
		}
		else { this.awaitingResponse = false; }
	}

	ErrorHandler(error)
	{
		if (error) this.adapter.log.console.error("Serialport Errorhandler: " + error);
	}

	async ProcessGatewayMessage(data)
	{
		this.adapter.log.info(JSON.stringify(data));
		if (data.length == 0) { this.ErrorHandler(new Error("Received parsed gateway message without content")); return;}

		if (data["methodResponse"])
		{ //There is a method response
			this.adapter.log.info("Method Response from gateway");
			this.WriteDelayedData();

			clearTimeout(this.connectionTimeout);


			if (data["methodResponse"]["array"][0]["string"] == "selve.GW.device.getIDs")
			{
				let bArray = this.DecodeBase64ToBoolArray(data["methodResponse"]["array"][0]["base64"]);
				this.adapter.log.info("Decoded: " + bArray.toString());

			}

		}
		else if (data["methodCall"])
		{
			if (data["methodCall"]["methodName"] == "selve.GW.event.dutyCycle")
			{
				await this.adapter.setStateAsync("Gateway.Mode", { val: parseInt(data["methodCall"]["array"][0]["int"][0]), ack: true });
				await this.adapter.setStateAsync("Gateway.DutyCycleOccupancyRate", { val: parseInt(data["methodCall"]["array"][0]["int"][1]), ack: true });
			}
		}
		else {this.ErrorHandler(new Error("unknown message from Gateway: " + JSON.stringify(data)));}
	}

	Ping()
	{
		this.WriteData("<methodCall><methodName>selve.GW.service.ping</methodName></methodCall>");
	}


	DecodeBase64ToBoolArray(base64String)
	{
		const decodedIDs = base64.decode(base64String);
		const byteArray = new Uint8Array(decodedIDs.length);
		for (let i = 0; i < decodedIDs.length; i++) { byteArray[i] = decodedIDs.charCodeAt(i);}
		this.adapter.log.info(byteArray.toString());

		// @ts-ignore
		const bs = new BitSet(Uint8Array.from(byteArray));

		const boolArray = new Array(64);
		for (let i = 0; i < 64; i++) boolArray[i] = bs.get(i) == 1;

		return boolArray;
	}

	//Length of boolArray has to be a multiple of 8
	EncodeBoolArrayToBase64(boolArray)
	{
		const byteArray = new Uint8Array(boolArray.length / 8);
		for (let i = 0; i < byteArray.length; i++)
		{
			for (let j = 7; j >= 0; j--)
			{
				if (boolArray[i * 8 + j]) byteArray[i] += 1;
				if (j > 0) byteArray[i] = byteArray[i] << 1;
			}
		}

		this.adapter.log.info(byteArray.toString());

		let stringToEncode = "";
		for (let i = 0; i < byteArray.length; i++)
		{
			stringToEncode += String.fromCharCode(byteArray[i]);
		}

		return base64.encode(stringToEncode);
	}

	LostConnectionHandler()
	{
		this.adapter.log.warn("Did not receive a method response from gateway within 5 seconds. Connection is probably lost");

		//Possibility to count lost messages and try a adapter restart if there are too many lost messages
	}
}

module.exports = SelveUSBGateway;