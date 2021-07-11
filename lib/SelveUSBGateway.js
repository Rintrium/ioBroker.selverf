"use strict";

const SerialPort = require("serialport");
const events = require("events");

const xml2js = require("xml2js");
const base64 = require("base-64");
const BitSet = require("bitset");

//#region Commeo definitions
const COMMEO_ACTUATOR_STATE_PREFIX = "actuator.commeo";
const COMMEO_COMMAND_STOP = 0;
const COMMEO_COMMAND_DRIVEUP = 1;
const COMMEO_COMMAND_DRIVEDOWN = 2;
const COMMEO_COMMAND_DRIVEPOS = 7;
const COMMEO_COMMAND_DRIVEPOS1 = 3;
const COMMEO_COMMAND_DRIVEPOS2 = 5;
//if needed StepUp + StepDown can be implemented


//only for setup
const COMMEO_COMMAND_SAVEPOS1 = 4
const COMMEO_COMMAND_SAVEPOS2 = 6;
//if needed AutoOn + AutoOff can be implemented

const COMMEO_COMMAND_TYPE_MANUAL = 1;
//#endregion

//#region Iveo definitions
const iveoActuatorStatePrefix = "actuator.iveo";


//#endregion

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
this.WriteDelayedData
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
		}
	}

	async InitializeGatewayStates()
	{
		await this.adapter.setObjectNotExistsAsync("gateway.dutyCycleOccupancyRate", {
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

		await this.adapter.setObjectNotExistsAsync("gateway.mode", {
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
		// @ts-ignore
		clearTimeout(this.connectionTimeout);
	}

	DataArrived(data)
	{
		//TODO: Implement receiving of multiple messages from the gateway at once. (did not occur until now)

		this.adapter.log.debug("Received data from gateway: " + data);

		//Add the newly arrived data to already received data, that did not form a complete xml message
		this.partialMessage = this.partialMessage + data;
		
		//message has to be trimmed, because sometimes there are unnecesary spaces at the end
		const trimmedMessage = this.partialMessage.trimEnd();
		
		//Gateway data always has to end with </methodCall> or </methodResponse>, so a complete message will evaluate true
		if (trimmedMessage.endsWith("</methodCall>") || trimmedMessage.endsWith("</methodResponse>"))
		{
			this.adapter.log.debug("Received complete XML message from gateway: " + trimmedMessage);
			
			//The data is complete and can be parsed
			xml2js.parseStringPromise(trimmedMessage, {tagValueProcessor : a => {
				if (Array.isArray(a)) return a.join(",");
				return a;
			}}).then(this.ProcessGatewayMessage.bind(this)).catch(this.ErrorHandler.bind(this));
			
			//reset partialMessage for the next data arrival
			this.partialMessage = "";
		}
	}


	WriteData(data)
	{
		//only write data, when the adapter is not awaiting a response from the gateway, otherwise queue the message to be sent later
		if (this.awaitingResponse)
		{
			this.delayedMessages.push(data);
		}
		else
		{
			this.gatewayPort.write(data, "utf8", this.ErrorHandler.bind(this));
			this.gatewayPort.drain();
			this.awaitingResponse = true;

			// @ts-ignore
			clearTimeout(this.connectionTimeout);
			this.connectionTimeout = setTimeout(this.LostConnectionHandler.bind(this), 5000);
		}
	}

	/**
	 * Do not use this to send messages to the gateway, this will be called from WriteData when appropiate.
	 */
	WriteDelayedData()
	{
		//write one queued message to the gateway or if there is no message left to be written clear awaitingResponse 
		//to enable direct message sending for the next write attempt
		if (this.delayedMessages.length > 0)
		{
			this.gatewayPort.write(this.delayedMessages.shift(), "utf8", this.ErrorHandler.bind(this));
			this.gatewayPort.drain();

			// @ts-ignore
			clearTimeout(this.connectionTimeout);
			this.connectionTimeout = setTimeout(this.LostConnectionHandler.bind(this), 5000);
		}
		else { this.awaitingResponse = false; }
	}

	ErrorHandler(error)
	{
		if (error) this.adapter.log.console.error("SelveRF Errorhandler: " + error);
	}

	async ProcessGatewayMessage(data)
	{
		this.adapter.log.debug(JSON.stringify(data));
		if (data.length == 0) { this.ErrorHandler(new Error("Received parsed gateway message without content")); return;}

		if (data["methodResponse"])
		{ 
			//There is a method response, this means if there is a queued message it can be sent now
			this.WriteDelayedData();

			// @ts-ignore
			clearTimeout(this.connectionTimeout);

			if (data["methodResponse"]["array"][0]["string"] == "selve.GW.service.ping")
			{
				if (!this.connectionEstablished)
				{
					this.connectionEstablished = true;
					this.adapter.connected = true;
					this.eventEmitter.emit("connected");
					this.adapter.log.info("Established communication with gateway");
				}
			}
			else if (data["methodResponse"]["array"][0]["string"] == "selve.GW.device.getIDs")
			{
				const bArray = this.DecodeBase64ToBoolArray(data["methodResponse"]["array"][0]["base64"]);

				for (let i = 0; i < 64; i++)
				{
					if (bArray[i])
					{
						this.InitiateCommeoActuatorStates(i);

						this.GetCommeoActuatorInfo(i);
						this.GetCommeoActuatorValues(i);
					}
				}
			}
			else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.device.getInfo")
			{
				this.HandleCommeoActuatorInfo(
					data["methodResponse"]["array"][0]["int"][0],
					data["methodResponse"]["array"][0]["string"][1],
					data["methodResponse"]["array"][0]["int"][2]
				);
			}
			else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.device.getValues")
			{
				this.HandleCommeoActuatorValues(
					data["methodResponse"]["array"][0]["int"][0],
					data["methodResponse"]["array"][0]["string"][1],
					data["methodResponse"]["array"][0]["int"][1],
					data["methodResponse"]["array"][0]["int"][2],
					data["methodResponse"]["array"][0]["int"][3]
				);
			}

		}
		else if (data["methodCall"])
		{
			if (data["methodCall"]["methodName"] == "selve.GW.event.dutyCycle")
			{
				await this.adapter.setStateAsync("gateway.mode", { val: parseInt(data["methodCall"]["array"][0]["int"][0]), ack: true });
				await this.adapter.setStateAsync("gateway.dutyCycleOccupancyRate", { val: parseInt(data["methodCall"]["array"][0]["int"][1]), ack: true });
			}
			else if (data["methodCall"]["methodName"] == "selve.GW.event.device")
			{
				this.HandleCommeoActuatorValues(
					data["methodCall"]["array"][0]["int"][0],
					data["methodCall"]["array"][0]["string"][0],
					data["methodCall"]["array"][0]["int"][1],
					data["methodCall"]["array"][0]["int"][2],
					data["methodCall"]["array"][0]["int"][3]
				);
			}
		}
		else {this.ErrorHandler(new Error("unknown message from Gateway: " + JSON.stringify(data)));}
	}

	//#region Gateway functions
	Ping()
	{
		this.WriteData("<methodCall><methodName>selve.GW.service.ping</methodName></methodCall>");
	}
	//#endregion

	//#region Commeo actuator functions

	//Setup function. Gets all actuator ids and subsequently sets all states in iobroker
	GetCommeoActuatorIDs()
	{
		this.adapter.log.info("Requested commeo actuator ids from gateway");
		this.WriteData("<methodCall><methodName>selve.GW.device.getIDs</methodName></methodCall>");
	}

	GetCommeoActuatorValues(index)
	{
		this.WriteData("<methodCall><methodName>selve.GW.device.getValues</methodName><array><int>" + index.toString() + "</int></array></methodCall>");
	}

	GetCommeoActuatorInfo(index)
	{
		this.WriteData("<methodCall><methodName>selve.GW.device.getInfo</methodName><array><int>" + index.toString() + "</int></array></methodCall>");
	}

	InitiateCommeoActuatorStates(index)
	{
		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".name", {
			type: "state",
			common: {
				name: "Name",
				type: "string",
				role: "info.name",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".actuatorType", {
			type: "state",
			common: {
				name: "ActuatorType",
				type: "number",
				role: "value",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".driveStatus", {
			type: "state",
			common: {
				name: "DriveStatus",
				type: "string",
				role: "text",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".position", {
			type: "state",
			common: {
				name: "Position",
				type: "number",
				role: "value",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".targetPosition", {
			type: "state",
			common: {
				name: "TargetPosition",
				type: "number",
				role: "value",
				read: true,
				write: true,
			},
			native: {},
		});
		this.adapter.subscribeStates(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".targetPosition");

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".up", {
			type: "state",
			common: {
				name: "Up",
				type: "boolean",
				role: "button",
				read: false,
				write: true,
			},
			native: {},
		});
		this.adapter.subscribeStates(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".up");

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".down", {
			type: "state",
			common: {
				name: "Down",
				type: "boolean",
				role: "button",
				read: false,
				write: true,
			},
			native: {},
		});
		this.adapter.subscribeStates(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".down");

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".stop", {
			type: "state",
			common: {
				name: "Stop",
				type: "boolean",
				role: "button",
				read: false,
				write: true,
			},
			native: {},
		});
		this.adapter.subscribeStates(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".stop");

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".drivePos1", {
			type: "state",
			common: {
				name: "DrivePos1",
				type: "boolean",
				role: "button",
				read: false,
				write: true,
			},
			native: {},
		});
		this.adapter.subscribeStates(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".drivePos1");

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".drivePos2", {
			type: "state",
			common: {
				name: "DrivePos2",
				type: "boolean",
				role: "button",
				read: false,
				write: true,
			},
			native: {},
		});
		this.adapter.subscribeStates(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".drivePos2");

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".setup.savePos1", {
			type: "state",
			common: {
				name: "SavePos1",
				type: "boolean",
				role: "button",
				read: false,
				write: true,
			},
			native: {},
		});
		this.adapter.subscribeStates(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".setup.savePos1");

		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".setup.savePos2", {
			type: "state",
			common: {
				name: "SavePos2",
				type: "boolean",
				role: "button",
				read: false,
				write: true,
			},
			native: {},
		});
		this.adapter.subscribeStates(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".setup.savePos2");
	}

	HandleCommeoActuatorInfo(actuatorID, actuatorName, configuration)
	{
		this.adapter.setStateAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".name",
			{ val: actuatorName, ack: true });
		this.adapter.setStateAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".actuatorType",
			{ val: parseInt(configuration), ack: true });
	}

	HandleCommeoActuatorValues(actuatorID, actuatorName, status, value, targetValue)
	{
		this.adapter.setStateAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".name",
			{ val: actuatorName, ack: true });
		let driveStatus = "Undefined";
		if (status == "1") driveStatus = "Stopped";
		else if (status == "2") driveStatus = "GoingUp";
		else if (status == "3") driveStatus = "GoingDown";
		this.adapter.setStateAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".driveStatus",
			{ val: driveStatus, ack: true });
		this.adapter.setStateAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".position",
			{ val: parseInt(value), ack: true });
		this.adapter.setStateAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".targetPosition",
			{ val: parseInt(targetValue), ack: true });
	}

	//#endregion

	HandleSubscribedStateChange(id, state)
	{
		let splitID = id.split(".");
		//[0] = selverf
		//[1] = instance number

		if (splitID[2] == "actuator")
		{
			if (splitID[3] == "commeo")
			{
				const commeoActuatorID = splitID[4];

				if (splitID[5] == "targetPosition")
				{
					this.WriteData(
						"<methodCall><methodName>selve.GW.command.device</methodName><array>\
						<int>" + commeoActuatorID + "</int>\
						<int>" + COMMEO_COMMAND_DRIVEPOS + "</int>\
						<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
						<int>" + state.val + "</int>\
						</array></methodCall>");
				}
				else if (splitID[5] == "up")
				{
					this.WriteData(
						"<methodCall><methodName>selve.GW.command.device</methodName><array>\
						<int>" + commeoActuatorID + "</int>\
						<int>" + COMMEO_COMMAND_DRIVEUP + "</int>\
						<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
						<int>0</int>\
						</array></methodCall>");
				}
				else if (splitID[5] == "down")
				{
					this.WriteData(
						"<methodCall><methodName>selve.GW.command.device</methodName><array>\
						<int>" + commeoActuatorID + "</int>\
						<int>" + COMMEO_COMMAND_DRIVEDOWN + "</int>\
						<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
						<int>0</int>\
						</array></methodCall>");
				}
				else if (splitID[5] == "stop")
				{
					this.WriteData(
						"<methodCall><methodName>selve.GW.command.device</methodName><array>\
						<int>" + commeoActuatorID + "</int>\
						<int>" + COMMEO_COMMAND_STOP + "</int>\
						<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
						<int>0</int>\
						</array></methodCall>");
				}
				else if (splitID[5] == "drivePos1")
				{
					this.WriteData(
						"<methodCall><methodName>selve.GW.command.device</methodName><array>\
						<int>" + commeoActuatorID + "</int>\
						<int>" + COMMEO_COMMAND_DRIVEPOS1 + "</int>\
						<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
						<int>0</int>\
						</array></methodCall>");
				}
				else if (splitID[5] == "drivePos2")
				{
					this.WriteData(
						"<methodCall><methodName>selve.GW.command.device</methodName><array>\
						<int>" + commeoActuatorID + "</int>\
						<int>" + COMMEO_COMMAND_DRIVEPOS2 + "</int>\
						<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
						<int>0</int>\
						</array></methodCall>");
				}
				else if (splitID[5] == "setup")
				{
					if (splitID[6] == "savePos1")
					{
						this.WriteData(
							"<methodCall><methodName>selve.GW.command.device</methodName><array>\
							<int>" + commeoActuatorID + "</int>\
							<int>" + COMMEO_COMMAND_SAVEPOS1 + "</int>\
							<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
							<int>0</int>\
							</array></methodCall>");
					}
					else if (splitID[6] == "savePos2")
					{
						this.WriteData(
							"<methodCall><methodName>selve.GW.command.device</methodName><array>\
							<int>" + commeoActuatorID + "</int>\
							<int>" + COMMEO_COMMAND_SAVEPOS2 + "</int>\
							<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
							<int>0</int>\
							</array></methodCall>");
					}
				}				
			}
		}
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

		this.adapter.connected = false;
		this.connectionEstablished = false;

		//Possibility to count lost messages and try a adapter restart if there are too many lost messages
	}
}

module.exports = SelveUSBGateway;