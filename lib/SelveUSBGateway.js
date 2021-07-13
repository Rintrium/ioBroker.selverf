"use strict";

const SerialPort = require("serialport");
const events = require("events");

const xml2js = require("xml2js");
const base64 = require("base-64");
const BitSet = require("bitset");

const GatewayCommand = require("./lib/GatewayCommand.js");

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
const COMMEO_COMMAND_SAVEPOS1 = 4;
const COMMEO_COMMAND_SAVEPOS2 = 6;
//if needed AutoOn + AutoOff can be implemented

const COMMEO_COMMAND_TYPE_MANUAL = 1;
//#endregion

//#region Iveo definitions
const iveoActuatorStatePrefix = "actuator.iveo";


//#endregion

const AGGREGATION_DURATION = 25; //ms
const AGGREGATION_MAX_TOTAL_DURATION = 300; //ms
const CONNECTION_TIMEOUT_DURATION = 5000; //ms
const RECONNECT_TIMEOUT_DURATION = 10000; //ms

class SelveUSBGateway {


	constructor(adapter) {

		this.adapter = adapter;
		this.eventEmitter = new events.EventEmitter();
		this.connectionEstablished = false;
		
		this.isSending = false;
		this.isAggregatingMessages = false;

		this.queuedMessages = new Array();
		this.messagesSending = new Array();
	}


	ConnectUSBGateway()
	{
		this.connectionEstablished = false;

		try {
			this.gatewayPort = new SerialPort(this.adapter.config.usbGatewayPath, { baudRate: 115200 }, this.ConnectionResultHandler.bind(this));

		} catch (error) {
			this.adapter.log.error("Invalid port: " + this.adapter.config.usbGatewayPath + "; Error: " + error);

			//Try again in 5 seconds
			this.reconnectTimeout = setTimeout(this.ConnectUSBGateway.bind(this), RECONNECT_TIMEOUT_DURATION);
		}
	}

	async ConnectionResultHandler(error)
	{
		if (error != null)
		{
			//There was an error; Try again in 5 seconds

			this.adapter.log.info("Connection result error: " + error);
			this.reconnectTimeout = setTimeout(this.ConnectUSBGateway.bind(this), RECONNECT_TIMEOUT_DURATION);

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
	}

	Unload()
	{
		// @ts-ignore
		clearTimeout(this.reconnectTimeout);
		// @ts-ignore
		clearTimeout(this.connectionTimeout);

		// @ts-ignore
		clearTimeout(this.aggregationTimeout);
		// @ts-ignore
		clearTimeout(this.maxTotalAggregationTimeout);

		this.gatewayPort.close(this.ErrorHandler.bind(this));
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
		this.adapter.log.debug("Sending message to gateway: " + data)
		this.gatewayPort.write(data, "utf8", this.ErrorHandler.bind(this));
		this.gatewayPort.drain(this.ErrorHandler.bind(this));

		// @ts-ignore
		clearTimeout(this.connectionTimeout);
		this.connectionTimeout = setTimeout(this.LostConnectionHandler.bind(this), 5000);
	}

	/**
	 * Do not use this to send messages to the gateway, this will be called from WriteData when appropiate.
	 */
	WriteDelayedData()
	{
		// @ts-ignore
		clearTimeout(this.connectionTimeout);

		//write one queued message to the gateway or if there is no message left to be written clear awaitingResponse
		//to enable direct message sending for the next write attempt
		if (this.delayedMessages.length > 0)
		{
			const dataToSend = this.delayedMessages.shift();
			this.adapter.log.debug("Sent delayed message to gateway: " + dataToSend)
			this.gatewayPort.write(dataToSend, "utf8", this.ErrorHandler.bind(this));
			this.gatewayPort.drain(this.ErrorHandler.bind(this));

			
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
			
			

			if (data["methodResponse"]["fault"])
			{
				this.adapter.log.error("Received fault code!");
			}
			else 
			{
				if (data["methodResponse"]["array"][0]["string"] == "selve.GW.service.ping")
				{
					if (!this.connectionEstablished)
					{
						this.connectionEstablished = true;
						this.adapter.log.info("Established communication with gateway");
						this.eventEmitter.emit("connected");
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

				//There is a method response, this means if there is a queued message it can be sent now
				this.WriteDelayedData();
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
		const splitID = id.split(".");
		
		this.queuedMessages.push(new GatewayCommand(splitID, state.val));
		
		this.BeginSendQueuedMessages();
	}

	/**
	 * If there is no message currently being sent, then begin sending timeout before sending. Otherwise do nothing (queued messages will be sent after completing the messagesSending queue)
	 */
	BeginSendQueuedMessages()
	{
		if (this.isAggregatingMessages) //At least second message while aggregating commands; isSending is still false
		{
			clearTimeout(this.aggregationTimeout);
			this.aggregationTimeout = setTimeout(this.SendQueuedMessages.bind(this), AGGREGATION_DURATION);
			
		}
		else if (!this.isSending) //First message and not sending
		{
			clearTimeout(this.aggregationTimeout);
			clearTimeout(this.maxTotalAggregationTimeout);
			this.maxTotalAggregationTimeout = setTimeout(this.SendQueuedMessages.bind(this), AGGREGATION_MAX_TOTAL_DURATION);
			this.aggregationTimeout = setTimeout(this.SendQueuedMessages.bind(this), AGGREGATION_DURATION);
			this.isAggregatingMessages = true;
		}
		//else do nothing. Queued messages have to be sent after completion of the messagesSending queue
	}

	/**
	 * Do not call this directly!
	 */
	SendQueuedMessages()
	{
		//First clear the timeouts that could potentially retrigger this function
		clearTimeout(this.aggregationTimeout);
		clearTimeout(this.maxTotalAggregationTimeout);

		this.isAggregatingMessages = false;
		this.isSending = true;
		
		let multipleIDsPossible = false;
		let firstMessage = this.queuedMessages.shift();
		this.messagesSending.push(firstMessage);
		let splitIDAggregationChecks = [];
		
		//take the first message and check, if it is a command that can affect multiple ids
		if (firstMessage.splitID[2] == "actuator")
		{
			if (firstMessage.splitID[3] == "commeo")
			{
				splitIDAggregationChecks = [2, 3];
				multipleIDsPossible = true;
			}
		}

		//if multiple ids are possible for this command push them into the messagesSending queue
		if (multipleIDsPossible)
		{
			let idIsQualified;
			for (let i = 0; i < this.queuedMessages.length; i++)
			{
				idIsQualified = true;
				for (let j = 0; j < splitIDAggregationChecks.length; j++)
				{
					if (firstMessage.splitID[splitIDAggregationChecks[j]] != this.queuedMessages[i].splitID[splitIDAggregationChecks[j]])
					{
						idIsQualified = false;
						break;
					}
				}

				if (idIsQualified)
				{
					this.messagesSending.push(this.queuedMessages[i]);
					this.queuedMessages.splice(i, 1);//remove the message from the original queue
					i--;
				}
			}
		}
		

		const xmlMessage = this.GenerateGatewayMessage();

		this.WriteData(xmlMessage);
	}

	/**
	 * Gateway message is generated based on the GatewayCommands in the messagesSending queue; also executes the PrepareForSendingQueue Function of the gateway command
	 * @returns {string}: returns the message for the gateway as string
	 */
	GenerateGatewayMessage()
	{
		//[0] = selverf
		//[1] = instance number
return "text";
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

		this.adapter.setStateAsync("info.connection", { val: false, ack: true });
		this.connectionEstablished = false;

		//Possibility to count lost messages and try a adapter restart if there are too many lost messages
	}
}

module.exports = SelveUSBGateway;