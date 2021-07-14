"use strict";

const SerialPort = require("serialport");
const events = require("events");

const xml2js = require("xml2js");
const base64 = require("base-64");
const BitSet = require("bitset");

const GatewayCommand = require("./GatewayCommand.js");

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
			this.messageBuffer = "";
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
		this.adapter.log.debug("Received raw data from gateway: " + data);

		//Add the newly arrived data to the messageBuffer
		this.messageBuffer = this.messageBuffer + data;

		let foundMethodCall, foundMethodResponse;
		foundMethodCall = this.messageBuffer.indexOf("</methodCall>");
		foundMethodResponse = this.messageBuffer.indexOf("</methodResponse>");

		while (foundMethodCall != -1 || foundMethodResponse != -1)
		{
			if (foundMethodCall != -1 && foundMethodResponse != -1)
			{
				if (foundMethodCall < foundMethodResponse) foundMethodResponse = -1;
				else foundMethodCall = -1;
			}

			let message;
			if (foundMethodResponse != -1)
			{
				message = this.messageBuffer.slice(0, foundMethodResponse + 17); //length of </methodResponse> is 17
				this.messageBuffer = this.messageBuffer.slice(foundMethodResponse + 17); //remove the extracted message from the messageBuffer
			}
			else //foundMethodCall has to be != -1
			{
				message = this.messageBuffer.slice(0, foundMethodCall + 13); //length of </methodResponse> is 13
				this.messageBuffer = this.messageBuffer.slice(foundMethodCall + 13); //remove the extracted message from the messageBuffer
			}

			this.adapter.log.debug("Received complete XML message from gateway: " + message);

			//The data is complete and can be parsed
			xml2js.parseStringPromise(message, {tagValueProcessor : a => {
				if (Array.isArray(a)) return a.join(",");
				return a;
			}}).then(this.ProcessGatewayMessage.bind(this)).catch(this.ErrorHandler.bind(this));


			foundMethodCall = this.messageBuffer.indexOf("</methodCall>");
			foundMethodResponse = this.messageBuffer.indexOf("</methodResponse>");
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

	ErrorHandler(error)
	{
		if (error) this.adapter.log.console.error("SelveRF Errorhandler: " + error);
	}


	/**
	 * Since ProcessGatewayMessage is called async after parsing the xml from the gateway messages may be out of order!
	 * @param {*} data 
	 * @returns 
	 */
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
		this.HandleInternalCommand(["inte","rnal","gateway","ping"], "0");
	}

	//Setup function. Gets all actuator ids and subsequently sets all states in iobroker
	GetCommeoActuatorIDs()
	{
		this.adapter.log.info("Requested commeo actuator ids from gateway");
		this.HandleInternalCommand(["inte","rnal","gateway","requestCommeoIDs"], "0");
	}

	GetCommeoActuatorValues(index)
	{
		this.HandleInternalCommand(["inte","rnal","gateway","requestCommeoValue"], index);
	}

	GetCommeoActuatorInfo(index)
	{
		this.HandleInternalCommand(["inte","rnal","gateway","requestCommeoInfo"], index);
	}
	//#endregion

	//#region Commeo actuator functions

	

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

		this.HandleInternalCommand(splitID, state.val);
	}

	HandleInternalCommand(splitID, val)
	{
		this.queuedMessages.push(new GatewayCommand(splitID, val));
		
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
		let valAggregationCheck = false; //if the value has to be checked
		
		//take the first message and check, if it is a command that can affect multiple ids
		if (firstMessage.splitID[2] == "actuator")
		{
			if (firstMessage.splitID[3] == "commeo")
			{
				if (firstMessage.splitID[5] != "targetPosition")
				{
					valAggregationCheck = true;
				}

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
				if (idIsQualified && valAggregationCheck && firstMessage.val != this.queuedMessages[i].val) idIsQualified = false;

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

		if (this.messagesSending[0].splitID[2] == "actuator")
		{
			if (this.messagesSending[0].splitID[3] == "commeo")
			{
				let valToSend = "0";
				let commeoCommand;

				switch (this.messagesSending[0].splitID[5]) {
					case "targetPosition":
						commeoCommand = COMMEO_COMMAND_DRIVEPOS;
						valToSend = this.messagesSending[0].val;
						break;
					case "up":
						commeoCommand = COMMEO_COMMAND_DRIVEUP;
						break;

					case "down":
						commeoCommand = COMMEO_COMMAND_DRIVEDOWN;
						break;

					case "stop":
						commeoCommand = COMMEO_COMMAND_STOP;
						break;

					case "drivePos1":
						commeoCommand = COMMEO_COMMAND_DRIVEPOS1;
						break;

					case "drivePos2":
						commeoCommand = COMMEO_COMMAND_DRIVEPOS2;
						break;

					case "setup":
						if (this.messagesSending[0].splitID[6] == "savePos1") commeoCommand = COMMEO_COMMAND_SAVEPOS1;
						else if (this.messagesSending[0].splitID[6] == "savePos2") commeoCommand = COMMEO_COMMAND_SAVEPOS2;
						else this.adapter.log.warn("Unkown command at GenerateGatewayMessage actuator.commeo: " + JSON.stringify(this.messagesSending[0].splitID));
					break;
				
					default:
						this.adapter.log.warn("Unkown command at GenerateGatewayMessage actuator.commeo: " + JSON.stringify(this.messagesSending[0].splitID));
						break;
				}

				this.PrepareGatewayCommands(4, true);

				if (this.messagesSending.length > 1)
				{ //multiple actuators
					const boolArray = new Array(64);
					for (let i = 0; i < 64; i++) boolArray[i] = false;
					for (let i = 0; i < this.messagesSending.length; i++) boolArray[this.messagesSending[i].identifier] = true;

					const base64EncodedActuators = this.EncodeBoolArrayToBase64(boolArray);

					return "<methodCall><methodName>selve.GW.command.groupMan</methodName><array>\
					<int>" + commeoCommand + "</int>\
					<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
					<base64>" + base64EncodedActuators + "</base64>\
					<int>" + valToSend + "</int>\
					</array></methodCall>";
				}
				else //single actuator
				{
					return "<methodCall><methodName>selve.GW.command.device</methodName><array>\
					<int>" + this.messagesSending[0].identifier + "</int>\
					<int>" + commeoCommand + "</int>\
					<int>" + COMMEO_COMMAND_TYPE_MANUAL + "</int>\
					<int>" + valToSend + "</int>\
					</array></methodCall>";
				}				
			}
		}
		else if (this.messagesSending[0].splitID[2] == "gateway")
		{
			if(this.messagesSending[0].splitID[3] == "ping")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, 0);
				return "<methodCall><methodName>selve.GW.service.ping</methodName></methodCall>";
			}
			else if (this.messagesSending[0].splitID[3] == "requestCommeoIDs")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, 0);
				return "<methodCall><methodName>selve.GW.device.getIDs</methodName></methodCall>";
			}
			else if (this.messagesSending[0].splitID[3] == "requestCommeoValue")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, this.messagesSending[0].val);
				return "<methodCall><methodName>selve.GW.device.getValues</methodName><array><int>" + this.messagesSending[0].val + "</int></array></methodCall>";
			}
			else if (this.messagesSending[0].splitID[3] == "requestCommeoInfo")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, this.messagesSending[0].val);
				return "<methodCall><methodName>selve.GW.device.getInfo</methodName><array><int>" + this.messagesSending[0].val + "</int></array></methodCall>";
			}
		}

		this.adapter.log.warn("Unkown command at GenerateGatewayMessage: " + JSON.stringify(this.messagesSending[0].splitID));
		return "";
	}

	/**
	 * 
	 * @param {number} positionOfId if the command to send has one or more specific actuators this is the position of the id in splitID[]
	 * @param {boolean} waitForExtraReponse if the command needs to wait for an extra response before finishing (besides MethodResponse)
	 */
	PrepareGatewayCommands(positionOfId, waitForExtraReponse)
	{
		for (let i = 0; i < this.messagesSending.length; i++)
		{
			this.messagesSending[i].PrepareForSendingQueue(waitForExtraReponse, parseInt(this.messagesSending[i].splitID[positionOfId]));
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