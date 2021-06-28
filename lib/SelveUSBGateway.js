"use strict";

const SerialPort = require("serialport");
const events = require("events");
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
			//xml2js.parseStringPromise(this.ChangeGatewayDataForParsing(trimmedMessage), {explicitArray:true}).then(this.ProcessGatewayMessage.bind(this)).catch(this.ErrorHandler.bind(this));
			//this.ProcessGatewayMessage(convert.xml2js(data, {compact: false}));
			this.partialMessage = "";
		}
		else
		{
			this.adapter.log.info("chaining data");
			//Angekommene Teilnachrichten wurden verkettet
		}
	}

	ParseGatewayData(data)
	{
		let processedData = new Array();
		//to skip the xml header
		let positionInString = 5;
		let foundPosition;
		let positionClosingTag;
		let endTagPosition;

		data = data.replace(/(\r\n|\n|\r)/gm, "");

		while (positionInString < data.length)
		{
			foundPosition = data.indexOf("<", positionInString);
			if (foundPosition == -1)
			{
				//There ist no remaining data to parse
				break;
			}
			else if (data[foundPosition + 1] == "/")
			{
				//ignore because closing tag. jump to the end of this tag
				positionInString = foundPosition + 2;
			}
			else //found a new Tag with data
			{
				positionClosingTag = data.indexOf(">", foundPosition);
				if (positionClosingTag == -1)
				{
					this.ErrorHandler(new Error("Malformed message from Gateway. Expected > after char " + foundPosition + " but was not found."));
					return processedData;
				}
				else
				{
					//Check if there is a corresponding value or the next tag. If there is a value add the value. if there the next tag add the found tag
					if (data[positionClosingTag] == "<") //next Tag
					{
						processedData.push(data.slice(foundPosition + 1, positionClosingTag - 1));
						positionInString = positionClosingTag;
					}
					else
					{
						endTagPosition = data.indexOf("<", positionClosingTag);
						if (endTagPosition == -1)
						{
							this.ErrorHandler(new Error("Malformed message from Gateway. Expected < after value " + positionClosingTag + " but was not found."));
							return processedData;
						}
						else
						{
							processedData.push(data.slice(positionClosingTag + 1, endTagPosition - 1));
							positionInString = endTagPosition + 1;
						}
					}
				}
			}
		}

		return processedData;

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

			this.adapter.log.info(data.methodResponse.array[0][0]);

		}
		else if (data.methodCall != null)
		{
			if (data.methodCall.methodName == "selve.GW.event.dutyCycle")
			{
				await this.adapter.setStateAsync("Gateway.Mode", { val: data.methodCall.array.arr[0], ack: true });
				await this.adapter.setStateAsync("Gateway.DutyCycleOccupancyRate", { val: data.methodCall.array.arr[1], ack: true });
			}
		}
		else {this.ErrorHandler(new Error("unknown message from Gateway: " + JSON.stringify(data)));}
	}


}

module.exports = SelveUSBGateway;