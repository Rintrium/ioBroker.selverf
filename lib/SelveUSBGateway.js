"use strict";

const SerialPort = require("serialport");
const events = require("events");

const xml2js = require("xml2js");
const base64 = require("base-64");
const BitSet = require("bitset");

const GatewayCommand = require("./GatewayCommand.js");

const utils = require("@iobroker/adapter-core");

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
const IVEO_ACTUATOR_STATE_PREFIX = "actuator.iveo";
const IVEO_COMMAND_STOP = 0;
const IVEO_COMMAND_DRIVEUP = 1;
const IVEO_COMMAND_DRIVEDOWN = 2;
const IVEO_COMMAND_DRIVEPOS1 = 3;
const IVEO_COMMAND_DRIVEPOS2 = 4;
//#endregion

const SENSOR_STATE_PREFIX = "sensor"

const AGGREGATION_DURATION = 15; //ms
const AGGREGATION_MAX_TOTAL_DURATION = 200; //ms
const CONNECTION_TIMEOUT_DURATION = 400; //ms
const RECONNECT_TIMEOUT_DURATION = 10000; //ms
const NUM_OF_RETRIES_AFTER_FAULT_AND_TIMEOUT = 3;
const DELAY_BETWEEN_MULTIPLE_MESSAGES = 10; //ms

class SelveUSBGateway {


	constructor(adapter) {

		this.adapter = adapter;
		this.eventEmitter = new events.EventEmitter();
		this.connectionEstablished = false;

		this.isSending = false;
		this.isAggregatingMessages = false;

		this.queuedMessages = new Array();
		this.messagesSending = new Array();

		this.lastWrittenMessage = "";
		this.activeRetry = 0;
	}


	ConnectUSBGateway()
	{
		this.connectionEstablished = false;

		try {
			this.gatewayPort = new SerialPort(this.adapter.config.usbGatewayPath, { baudRate: 115200, lock: true }, this.ConnectionResultHandler.bind(this));

		} catch (error) {
			this.adapter.log.error("Invalid port: " + this.adapter.config.usbGatewayPath + "; Error: " + error);

			//Try again in 5 seconds
			this.connectionTimeout = setTimeout(this.ConnectUSBGateway.bind(this), RECONNECT_TIMEOUT_DURATION);
		}
	}

	async ConnectionResultHandler(error)
	{
		if (error != null)
		{
			//There was an error; Try again in 5 seconds, except when already trying to reestablish connection

			if (this.activeRetry > 0)
			{
				this.adapter.terminate(
					"Could not reestablish connection with gateway through serialport, but had a connection before",
					utils.EXIT_CODES.START_IMMEDIATELY_AFTER_STOP,
				);
			}

			this.adapter.log.error("Connection result error: " + error);
			this.connectionTimeout = setTimeout(this.ConnectUSBGateway.bind(this), RECONNECT_TIMEOUT_DURATION);

		}
		else
		{
			await this.InitializeGatewayStates();

			this.gatewayPort.setEncoding("utf8");
			this.gatewayPort.flush(this.ErrorHandler.bind(this));
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
		clearTimeout(this.connectionTimeout);

		// @ts-ignore
		clearTimeout(this.retryCounterResetTimeout);

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

			let message, messageBegin, discardedMessage = false;
			if (foundMethodResponse != -1)
			{
				messageBegin = this.messageBuffer.indexOf("<methodResponse>");

				if (messageBegin != -1 && messageBegin < foundMethodResponse) //has to be found and be before the end tag
				{

					message = this.messageBuffer.slice(messageBegin, foundMethodResponse + 17); //length of </methodResponse> is 17
					this.messageBuffer = this.messageBuffer.slice(foundMethodResponse + 17); //remove the extracted message from the messageBuffer
				}
				else //There is an incomplete message. Discard it
				{
					this.adapter.log.debug("Discarded incomplete data from gateway: " + this.messageBuffer.slice(0, foundMethodResponse + 17));
					this.messageBuffer = this.messageBuffer.slice(foundMethodResponse + 17); //remove the extracted message from the messageBuffer
					discardedMessage = true;
				}
			}
			else //foundMethodCall has to be != -1
			{
				messageBegin = this.messageBuffer.indexOf("<methodCall>");

				if (messageBegin != -1 && messageBegin < foundMethodCall) //has to be found and be before the end tag
				{

					message = this.messageBuffer.slice(messageBegin, foundMethodCall + 13); //length of </methodResponse> is 13
					this.messageBuffer = this.messageBuffer.slice(foundMethodCall + 13); //remove the extracted message from the messageBuffer
				}
				else //There is an incomplete message. Discard it
				{
					this.adapter.log.debug("Discarded incomplete data from gateway: " + this.messageBuffer.slice(0, foundMethodCall + 13));
					this.messageBuffer = this.messageBuffer.slice(foundMethodResponse + 13); //remove the extracted message from the messageBuffer
					discardedMessage = true;
				}
			}

			if (!discardedMessage)
			{
				this.adapter.log.debug("Received complete XML message from gateway: " + message);

				//The data is complete and can be parsed
				xml2js.parseStringPromise(message, {tagValueProcessor : a => {
					if (Array.isArray(a)) return a.join(",");
					return a;
				}}).then(this.ProcessGatewayMessage.bind(this)).catch(this.ErrorHandler.bind(this));
			}

			foundMethodCall = this.messageBuffer.indexOf("</methodCall>");
			foundMethodResponse = this.messageBuffer.indexOf("</methodResponse>");
		}
	}


	WriteData(data)
	{
		this.adapter.log.debug("Sending message to gateway: " + data);
		this.lastWrittenMessage = data;
		this.gatewayPort.write(data, "utf8", this.ErrorHandler.bind(this));
		this.gatewayPort.drain(this.ErrorHandler.bind(this));
	}

	ErrorHandler(error)
	{
		if (error) this.adapter.log.error("SelveRF Errorhandler: " + error);
	}


	/**
	 * Since ProcessGatewayMessage is called async after parsing the xml from the gateway messages may be out of order!
	 * @param {*} data
	 */
	async ProcessGatewayMessage(data)
	{
		this.adapter.log.debug("Parsed data: " + JSON.stringify(data));
		if (data.length == 0) { this.ErrorHandler(new Error("Received parsed gateway message without content")); return;}

		if (data["methodResponse"])
		{
			if (data["methodResponse"]["fault"]) //every other method response has to clear sendingMessages
			{
				this.adapter.log.error("Received fault code!");
				this.adapter.log.error("Response from gateway was: " + JSON.stringify(data));
				this.adapter.log.info("Last sent message was: " + this.lastWrittenMessage);

				this.adapter.log.info("Retrying after reconnection in " + CONNECTION_TIMEOUT_DURATION + " ms.");

				// @ts-ignore
				clearTimeout(this.connectionTimeout);
				this.connectionTimeout = setTimeout(this.RetryHandler.bind(this), CONNECTION_TIMEOUT_DURATION);
			}
			else
			{
				if (data["methodResponse"]["array"][0]["string"] == "selve.GW.service.ping")
				{
					if (!this.connectionEstablished)
					{
						this.connectionEstablished = true;
						this.adapter.log.info("Established communication with gateway");

						this.ClearCommandFromSendingQueue(["inte","rnal","gateway","ping"], [0,1,2,3],[0]);

						if (this.activeRetry > 0)
						{
							this.eventEmitter.emit("reconnected");
							this.retryCounterResetTimeout = setTimeout((() => {
								this.activeRetry = 0;
							}).bind(this), (3000));

						}
						else
						{
							this.eventEmitter.emit("connected");
						}
					}
				}
				else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.service.getVersion")
				{
					this.adapter.log.debug("Gateway Version - Part 1: " + data["methodResponse"]["array"][0]["int"][0] +
					" Part 2: " + data["methodResponse"]["array"][0]["int"][1] +
					" Part 3: " + data["methodResponse"]["array"][0]["int"][2] +
					" SpecPart 1: " + data["methodResponse"]["array"][0]["int"][3] +
					" SpecPart 2: " + data["methodResponse"]["array"][0]["int"][4] +
					" SerialNo: " + data["methodResponse"]["array"][0]["string"][1] +
					" Revision: " + data["methodResponse"]["array"][0]["int"][5]);

					this.ClearCommandFromSendingQueue(["inte","rnal","gateway","getVersion"], [0,1,2,3],[0]);
				}
				else if (data["methodResponse"]["array"][0]["string"] == "selve.GW.device.getIDs")
				{
					const bArray = this.DecodeBase64ToBoolArray(data["methodResponse"]["array"][0]["base64"]);

					this.ClearCommandFromSendingQueue(["inte","rnal","gateway","requestCommeoIDs"], [0,1,2,3], [0]);

					let numOfCommeoActuators = 0;
					for (let i = 0; i < 64; i++)
					{
						if (bArray[i])
						{
							numOfCommeoActuators++;

							this.InitiateCommeoActuatorStates(i);

							this.GetCommeoActuatorInfo(i);
							this.GetCommeoActuatorValues(i);
						}
					}

					this.adapter.log.info("Found " + numOfCommeoActuators + " Commeo actuators");
				}
				else if (data["methodResponse"]["array"][0]["string"] == "selve.GW.iveo.getIDs")
				{
					const bArray = this.DecodeBase64ToBoolArray(data["methodResponse"]["array"][0]["base64"]);

					this.ClearCommandFromSendingQueue(["inte","rnal","gateway","requestIveoIDs"], [0,1,2,3], [0]);

					let numOfIveoActuators = 0;
					for (let i = 0; i < 64; i++)
					{
						if (bArray[i])
						{
							numOfIveoActuators++;

							this.InitiateIveoActuatorStates(i);

							this.GetIveoActuatorConfig(i);
						}
					}

					this.adapter.log.info("Found " + numOfIveoActuators + " Iveo actuators");
				}
				else if (data["methodResponse"]["array"][0]["string"] == "selve.GW.sensor.getIDs")
				{
					const bArray = this.DecodeBase64ToBoolArray(data["methodResponse"]["array"][0]["base64"]);

					this.ClearCommandFromSendingQueue(["inte","rnal","gateway","requestSensorIDs"], [0,1,2,3], [0]);

					let numOfSensors = 0;
					for (let i = 0; i < 8; i++)
					{
						if (bArray[i])
						{
							numOfSensors++;

							this.InitiateSensorStates(i);

							this.GetSensorInfo(i);
							this.GetSensorValues(i);
						}
					}

					this.adapter.log.info("Found " + numOfSensors + " sensors");
				}
				else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.iveo.getConfig")
				{
					this.ClearCommandFromSendingQueue(["inte","rnal","gateway","requestIveoConfig"], [0,1,2,3], [parseInt(data["methodResponse"]["array"][0]["int"][0])]);

					this.HandleIveoActuatorConfig(
						data["methodResponse"]["array"][0]["int"][0],
						data["methodResponse"]["array"][0]["string"][1],
						data["methodResponse"]["array"][0]["int"][2]
					);
				}
				else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.device.getInfo")
				{
					this.ClearCommandFromSendingQueue(["inte","rnal","gateway","requestCommeoInfo"], [0,1,2,3], [parseInt(data["methodResponse"]["array"][0]["int"][0])]);

					this.HandleCommeoActuatorInfo(
						data["methodResponse"]["array"][0]["int"][0],
						data["methodResponse"]["array"][0]["string"][1],
						data["methodResponse"]["array"][0]["int"][2]
					);
				}
				else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.device.getValues")
				{
					this.ClearCommandFromSendingQueue(["inte","rnal","gateway","requestCommeoValue"], [0,1,2,3], [parseInt(data["methodResponse"]["array"][0]["int"][0])]);

					this.HandleCommeoActuatorValues(
						data["methodResponse"]["array"][0]["int"][0],
						data["methodResponse"]["array"][0]["string"][1],
						data["methodResponse"]["array"][0]["int"][1],
						data["methodResponse"]["array"][0]["int"][2],
						data["methodResponse"]["array"][0]["int"][3]
					);
				}
				else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.sensor.getInfo")
				{
					this.ClearCommandFromSendingQueue(["inte","rnal","gateway","requestSensorInfo"], [0,1,2,3], [parseInt(data["methodResponse"]["array"][0]["int"][0])]);

					this.HandleSensorInfo(
						data["methodResponse"]["array"][0]["int"][0],
						data["methodResponse"]["array"][0]["string"][1]
					);
				}
				else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.sensor.getValues")
				{
					this.ClearCommandFromSendingQueue(["inte","rnal","gateway","requestSensorValues"], [0,1,2,3], [parseInt(data["methodResponse"]["array"][0]["int"][0])]);

					this.HandleSensorValues(
						data["methodResponse"]["array"][0]["int"][0],
						data["methodResponse"]["array"][0]["int"][1],
						data["methodResponse"]["array"][0]["int"][2],
						data["methodResponse"]["array"][0]["int"][3],
						data["methodResponse"]["array"][0]["int"][4],
						data["methodResponse"]["array"][0]["int"][5],
						data["methodResponse"]["array"][0]["int"][6],
						data["methodResponse"]["array"][0]["int"][7],
						data["methodResponse"]["array"][0]["int"][9], //this is no error. i reordered the values
						data["methodResponse"]["array"][0]["int"][8],
						data["methodResponse"]["array"][0]["int"][10],
						data["methodResponse"]["array"][0]["int"][11]
					);
				}
				else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.command.device")
				{
					if (data["methodResponse"]["array"][0]["int"][0] == 1) //command was successfull
					{
						this.ClearCommandFromSendingQueue(["","", "actuator", "commeo"], [2,3], [-1]);
					}
					else
					{
						this.ErrorHandler(new Error("command.device unsucessfull (method response)")); //TODO better error handling
					}
				}
				else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.iveo.commandManual")
				{
					if (data["methodResponse"]["array"][0]["int"][0] == 1) //command was successfull
					{
						this.ClearCommandFromSendingQueue(["","", "actuator", "iveo"], [2,3], [-1]);
					}
					else
					{
						this.ErrorHandler(new Error("iveo.commandManual unsucessfull (method response)")); //TODO better error handling
					}
				}
				else if (data["methodResponse"]["array"][0]["string"][0] == "selve.GW.command.groupMan")
				{
					if (data["methodResponse"]["array"][0]["int"][0] == 1) //command was successfull
					{
						//base64 value is in documentation but not in real answers from gateway!!
						//const bArray = this.DecodeBase64ToBoolArray(data["methodResponse"]["array"][0]["base64"]);
						//const actuatorIDArray = new Array();
						//for (let i = 0; i < 64; i++) if (bArray[i]) actuatorIDArray.push(i);

						this.ClearCommandFromSendingQueue(["","", "actuator", "commeo"], [2,3], [-1]);//actuatorIDArray);
					}
					else
					{
						this.ErrorHandler(new Error("command.device unsucessfull (method response)")); //TODO better error handling
					}
				}
				else
				{
					this.adapter.log.warn("Not implemented method response message from gateway: " + JSON.stringify(data));
				}
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
			else if (data["methodCall"]["methodName"] == "selve.GW.command.result")
			{
				const success = data["methodCall"]["array"][0]["int"][2];
				const maskSuccess = data["methodCall"]["array"][0]["base64"][0];
				const maskFailed = data["methodCall"]["array"][0]["base64"][1];

				if (success == 1) //no errors while executing command
				{
					const bArray = this.DecodeBase64ToBoolArray(maskSuccess);

					const actuatorIDArray = new Array();
					for (let i = 0; i < 64; i++) if (bArray[i]) actuatorIDArray.push(i);

					this.ClearCommandFromSendingQueue(["","", "actuator", "commeo"], [2,3], actuatorIDArray);
				}
				else //there is at least one actuator, that did not execute the command
				{
					this.ErrorHandler(new Error("command.device unsucessfull (command.result)")); //TODO better error handling
				}
			}
			else if (data["methodCall"]["methodName"] == "selve.GW.iveo.commandResult")
			{
				const maskSuccess = data["methodCall"]["array"][0]["base64"][0];

				const bArray = this.DecodeBase64ToBoolArray(maskSuccess);

				const actuatorIDArray = new Array();
				for (let i = 0; i < 64; i++) if (bArray[i]) actuatorIDArray.push(i);

				this.ClearCommandFromSendingQueue(["","", "actuator", "iveo"], [2,3], actuatorIDArray);
			}
			else if (data["methodCall"]["methodName"] == "selve.GW.event.sensor")
			{
				this.HandleSensorValues(
					data["methodCall"]["array"][0]["int"][0],
					data["methodCall"]["array"][0]["int"][1],
					data["methodCall"]["array"][0]["int"][2],
					data["methodCall"]["array"][0]["int"][3],
					data["methodCall"]["array"][0]["int"][4],
					data["methodCall"]["array"][0]["int"][5],
					data["methodCall"]["array"][0]["int"][6],
					data["methodCall"]["array"][0]["int"][7],
					data["methodCall"]["array"][0]["int"][9], //this is no error. i reordered the values
					data["methodCall"]["array"][0]["int"][8],
					data["methodCall"]["array"][0]["int"][10],
					data["methodCall"]["array"][0]["int"][11]
				);
			}
			else
			{
				this.adapter.log.warn("Not implemented method call message from gateway: " + JSON.stringify(data));
			}
		}
		else
		{
			//this.ErrorHandler(new Error("unknown message from Gateway: " + JSON.stringify(data)));
			this.adapter.log.warn("Not implemented message from gateway: " + JSON.stringify(data));
		}
	}

	//#region Gateway functions
	Ping()
	{
		this.queuedMessages.unshift(new GatewayCommand(["inte","rnal","gateway","ping"], "0"));

		this.SendQueuedMessages(); //Ping has to send before any other commands. Aggregation is unnecessary
	}

	GetGatewayVersion()
	{
		this.HandleInternalCommand(["inte","rnal","gateway","getVersion"], "0");
	}
	//#endregion

	//#region CommeoFu
	//Setup function. Gets all actuator ids and subsequently sets all states in iobroker
	
	//#endregion

	//#region Commeo actuator functions
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


		this.adapter.setObjectNotExistsAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".scaledPosition", {
			type: "state",
			common: {
				name: "ScaledPosition",
				type: "number",
				role: "level.blind",
				min: 0,
				max: 100,
				unit: "%",
				read: true,
				write: true,
			},
			native: {},
		});
		this.adapter.subscribeStates(COMMEO_ACTUATOR_STATE_PREFIX + "." + index + ".scaledPosition");


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
		this.adapter.setStateAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".scaledPosition",
			{ val: (Math.max(0, Math.min(100, Math.round(parseInt(value)/65535*100)))), ack: true });
		this.adapter.setStateAsync(COMMEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".targetPosition",
			{ val: parseInt(targetValue), ack: true });
	}
	//#endregion

	//#region Iveo actuator functions
	InitiateIveoActuatorStates(index)
	{
		this.adapter.setObjectNotExistsAsync(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".name", {
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

		this.adapter.setObjectNotExistsAsync(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".actuatorType", {
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

		this.adapter.setObjectNotExistsAsync(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".up", {
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
		this.adapter.subscribeStates(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".up");

		this.adapter.setObjectNotExistsAsync(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".down", {
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
		this.adapter.subscribeStates(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".down");

		this.adapter.setObjectNotExistsAsync(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".stop", {
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
		this.adapter.subscribeStates(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".stop");

		this.adapter.setObjectNotExistsAsync(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".drivePos1", {
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
		this.adapter.subscribeStates(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".drivePos1");

		this.adapter.setObjectNotExistsAsync(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".drivePos2", {
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
		this.adapter.subscribeStates(IVEO_ACTUATOR_STATE_PREFIX + "." + index + ".drivePos2");
	}

	HandleIveoActuatorConfig(actuatorID, actuatorName, actuatorType)
	{
		this.adapter.setStateAsync(IVEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".name",
			{ val: actuatorName, ack: true });
		this.adapter.setStateAsync(IVEO_ACTUATOR_STATE_PREFIX + "." + actuatorID + ".actuatorType",
			{ val: parseInt(actuatorType), ack: true });
	}

	GetIveoActuatorIDs()
	{
		this.adapter.log.info("Requested iveo actuator ids from gateway");
		this.HandleInternalCommand(["inte","rnal","gateway","requestIveoIDs"], "0");
	}

	GetIveoActuatorConfig(index)
	{
		this.HandleInternalCommand(["inte","rnal","gateway","requestIveoConfig"], index);
		
	}
	//#endregion

	//#region Sensor functions
	InitiateSensorStates(index)
	{
		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".name", {
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

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".sensorStatus", {
			type: "state",
			common: {
				name: "SensorStatus",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".windDigital", {
			type: "state",
			common: {
				name: "WindDigital",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".rainDigital", {
			type: "state",
			common: {
				name: "RainDigital",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".tempDigital", {
			type: "state",
			common: {
				name: "TempDigital",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".lightDigital", {
			type: "state",
			common: {
				name: "LightDigital",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".tempAnalog", {
			type: "state",
			common: {
				name: "TempAnalog",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".windAnalog", {
			type: "state",
			common: {
				name: "WindAnalog",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".sun1Analog", {
			type: "state",
			common: {
				name: "Sun1Analog",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".sun2Analog", {
			type: "state",
			common: {
				name: "Sun2Analog",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".sun3Analog", {
			type: "state",
			common: {
				name: "Sun3Analog",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});

		this.adapter.setObjectNotExistsAsync(SENSOR_STATE_PREFIX + "." + index + ".dayLightAnalog", {
			type: "state",
			common: {
				name: "DayLightAnalog",
				type: "number",
				role: "value",
				unit: "",
				read: true,
				write: false,
			},
			native: {},
		});
	}

	HandleSensorInfo(actuatorID, sensorName)
	{
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".name",
			{ val: sensorName, ack: true });
	}

	HandleSensorValues(actuatorID, windDigital, rainDigital, tempDigital, lightDigital, sensorStatus, tempAnalog, windAnalog, dayLightAnalog, sun1Analog, sun2Analog, sun3Analog)
	{
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".windDigital",
			{ val: parseInt(windDigital), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".rainDigital",
			{ val: parseInt(rainDigital), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".tempDigital",
			{ val: parseInt(tempDigital), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".lightDigital",
			{ val: parseInt(lightDigital), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".sensorStatus",
			{ val: parseInt(sensorStatus), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".tempAnalog",
			{ val: parseInt(tempAnalog), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".windAnalog",
			{ val: parseInt(windAnalog), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".dayLightAnalog",
			{ val: parseInt(dayLightAnalog), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".sun1Analog",
			{ val: parseInt(sun1Analog), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".sun2Analog",
			{ val: parseInt(sun2Analog), ack: true });
		this.adapter.setStateAsync(SENSOR_STATE_PREFIX + "." + actuatorID + ".sun3Analog",
			{ val: parseInt(sun3Analog), ack: true });
			
	}

	GetSensorValues(index)
	{
		this.HandleInternalCommand(["inte","rnal","gateway","requestSensorValues"], index);
	}

	GetSensorInfo(index)
	{
		this.HandleInternalCommand(["inte","rnal","gateway","requestSensorInfo"], index);
	}

	GetSensorIDs()
	{
		this.adapter.log.info("Requested sensor ids from gateway");
		this.HandleInternalCommand(["inte","rnal","gateway","requestSensorIDs"], "0");
	}
	//#endregion

	HandleSubscribedStateChange(id, state)
	{
		const splitID = id.split(".");

		if (splitID[2] == "actuator" && splitID[3] == "commeo" && splitID[5] == "scaledPosition") //translation into targetPosition
		{
			splitID[5] = "targetPosition";
			this.HandleInternalCommand(splitID, (Math.max(0, Math.min(65535, Math.round(state.val/100*65535)))));
		}
		else
		{
			this.HandleInternalCommand(splitID, state.val);
		}
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
			// @ts-ignore
			clearTimeout(this.aggregationTimeout);
			this.aggregationTimeout = setTimeout(this.SendQueuedMessages.bind(this), AGGREGATION_DURATION);
		}
		else if (!this.isSending) //First message and not sending
		{
			// @ts-ignore
			clearTimeout(this.aggregationTimeout);
			// @ts-ignore
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
		// @ts-ignore
		clearTimeout(this.aggregationTimeout);
		// @ts-ignore
		clearTimeout(this.maxTotalAggregationTimeout);

		this.isAggregatingMessages = false;
		this.isSending = true;

		let multipleIDsPossible = false;
		const firstMessage = this.queuedMessages.shift();
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

				if (firstMessage.splitID[5]  == "setup")
				{
					splitIDAggregationChecks = [2,3,5,6];
				}
				else
				{
					splitIDAggregationChecks = [2,3,5];
				}

				multipleIDsPossible = true;
			}
			else if(firstMessage.splitID[3] == "iveo")			
			{
				splitIDAggregationChecks = [2,3,5];
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
					try
					{
						if (firstMessage.splitID[splitIDAggregationChecks[j]] != this.queuedMessages[i].splitID[splitIDAggregationChecks[j]])
						{
							idIsQualified = false;
							break;
						}
					}
					catch  (err)
					{
						//if one of the is longer there can be an out of bounds in the array of queuedMessages[i].splitID
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

		// @ts-ignore
		clearTimeout(this.connectionTimeout);
		this.connectionTimeout = setTimeout(this.LostConnectionHandler.bind(this), CONNECTION_TIMEOUT_DURATION);
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
				

				this.PrepareGatewayCommands(4, true); //Execute PrepareForSendingQueue on every command in the queue

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
			else if (this.messagesSending[0].splitID[3] == "iveo")
			{
				let iveoCommand;

				switch (this.messagesSending[0].splitID[5]) {
					case "up":
						iveoCommand = IVEO_COMMAND_DRIVEUP;
						break;

					case "down":
						iveoCommand = IVEO_COMMAND_DRIVEDOWN;
						break;

					case "stop":
						iveoCommand = IVEO_COMMAND_STOP;
						break;

					case "drivePos1":
						iveoCommand = IVEO_COMMAND_DRIVEPOS1;
						break;

					case "drivePos2":
						iveoCommand = IVEO_COMMAND_DRIVEPOS2;
						break;

					default:
						this.adapter.log.warn("Unkown command at GenerateGatewayMessage actuator.iveo: " + JSON.stringify(this.messagesSending[0].splitID));
						break;
				}

				this.PrepareGatewayCommands(4, true); //Execute PrepareForSendingQueue on every command in the queue

				//Iveo commands are always group commands
				const boolArray = new Array(64);
				for (let i = 0; i < 64; i++) boolArray[i] = false;
				for (let i = 0; i < this.messagesSending.length; i++) boolArray[this.messagesSending[i].identifier] = true;

				const base64EncodedActuators = this.EncodeBoolArrayToBase64(boolArray);

				return "<methodCall><methodName>selve.GW.iveo.commandManual</methodName><array>\
				<base64>" + base64EncodedActuators + "</base64>\
				<int>" + iveoCommand + "</int>\
				</array></methodCall>";
			}
		}
		else if (this.messagesSending[0].splitID[2] == "gateway")
		{
			if(this.messagesSending[0].splitID[3] == "ping")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, 0);
				return "<methodCall><methodName>selve.GW.service.ping</methodName></methodCall>";
			}
			else if (this.messagesSending[0].splitID[3] == "getVersion")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, 0);
				return "<methodCall><methodName>selve.GW.service.getVersion</methodName></methodCall>";
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
			else if (this.messagesSending[0].splitID[3] == "requestIveoIDs")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, this.messagesSending[0].val);
				return "<methodCall><methodName>selve.GW.iveo.getIDs</methodName></methodCall>";
			}
			else if (this.messagesSending[0].splitID[3] == "requestIveoConfig")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, this.messagesSending[0].val);
				return "<methodCall><methodName>selve.GW.iveo.getConfig</methodName><array><int>" + this.messagesSending[0].val + "</int></array></methodCall>";
			}
			else if (this.messagesSending[0].splitID[3] == "requestSensorValues")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, this.messagesSending[0].val);
				return "<methodCall><methodName> selve.GW.sensor.getValues</methodName><array><int>" + this.messagesSending[0].val + "</int></array></methodCall>";
			}
			else if (this.messagesSending[0].splitID[3] == "requestSensorInfo")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, this.messagesSending[0].val);
				return "<methodCall><methodName>elve.GW.sensor.getInfo</methodName><array><int>" + this.messagesSending[0].val + "</int></array></methodCall>";
			}
			else if (this.messagesSending[0].splitID[3] == "requestSensorIDs")
			{
				this.messagesSending[0].PrepareForSendingQueue(false, this.messagesSending[0].val);
				return "<methodCall><methodName>selve.GW.sensor.getIDs</methodName></methodCall>";
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

	/**
	 * Clears commands defined bei multiple splitID Arrays within another array; if the messagesSending queue is cleared start sending the next message if there are queued messages
	 * @param {string[]} expectedSplitID splitID Array of strings
	 * @param {number[]} actuatorID Array of actuatorIDs corresponding to the Array of splitIDs. Set first entry to -1 to ignore
	 * @param {number[]} splitIDChecks int array that defines which parts of the splitID are checked for a match
	 */
	ClearCommandFromSendingQueue(expectedSplitID, splitIDChecks, actuatorID)
	{
		let splitIDMatch = true;
		for (let j = 0; j < this.messagesSending.length; j++)
		{
			splitIDMatch = true;
			for (let k = 0; k < splitIDChecks.length; k++)
			{
				if (this.messagesSending[j].splitID[splitIDChecks[k]] != expectedSplitID[splitIDChecks[k]]) splitIDMatch = false;
			}

			if (splitIDMatch)
			{
				for (let i = 0; i < actuatorID.length; i++)
				{
					if (this.messagesSending[j].identifier == actuatorID[i] || actuatorID[i] == -1) //there is a match, the command can be removed or at least marked as cleared once
					{
						if (this.messagesSending[j].waitForExtraResponse)
						{
							if (this.messagesSending[j].clearedOnce) //can be removed
							{
								this.messagesSending.splice(j, 1);
								j--;
								break;
							}
							else //mark as clearedOnce
							{
								this.messagesSending[j].clearedOnce = true;
								break;
							}
						}
						else //can be removed
						{
							this.messagesSending.splice(j, 1);
							j--;
							break;
						}
					}
				}
			}
		}


		if (this.messagesSending.length == 0)
		{
			this.isSending = false;
			// @ts-ignore
			clearTimeout(this.connectionTimeout);
			if (this.queuedMessages.length > 0)
			{
				//delay multiple messages by set amount
				this.connectionTimeout = setTimeout(this.SendQueuedMessages.bind(this), DELAY_BETWEEN_MULTIPLE_MESSAGES);
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
		this.adapter.log.warn("Did not receive a method response from gateway within " + CONNECTION_TIMEOUT_DURATION + "ms. Connection is probably lost");


		this.RetryHandler();
	}

	RetryHandler()
	{
		this.activeRetry++;
		// @ts-ignore
		clearTimeout(this.connectionTimeout);
		// @ts-ignore
		clearTimeout(this.retryCounterResetTimeout);

		if (this.activeRetry > NUM_OF_RETRIES_AFTER_FAULT_AND_TIMEOUT)
		{
			//Restart adapter
			this.adapter.terminate(
				"Could not reestablish connection with gateway after " + NUM_OF_RETRIES_AFTER_FAULT_AND_TIMEOUT + " tries",
				utils.EXIT_CODES.START_IMMEDIATELY_AFTER_STOP,
			);
		}
		else
		{

			this.adapter.log.warn("Trying to reestablish connection with gateway. Try number " + this.activeRetry);

			//Close the connection
			try
			{
				this.gatewayPort.flush(this.ErrorHandler.bind(this));
				this.gatewayPort.close(this.ErrorHandler.bind(this));
				this.connectionEstablished = false;
				this.adapter.setStateAsync("info.connection", { val: false, ack: true });
			}
			catch(err)
			{
				this.adapter.log.error("Could not close connection: " + err);

				this.adapter.terminate(
					"Could not close connection with gateway",
					utils.EXIT_CODES.START_IMMEDIATELY_AFTER_STOP,
				);
			}

			while (this.messagesSending.length > 0) //Put the messages that were sending back into the QueuedMessages
			{
				if (this.messagesSending[0].splitID[2] == "gateway" && this.messagesSending[0].splitID[3] == "ping")
				{
					this.messagesSending.pop(); //Remove old ping, so it is not resend after reconnection
				}
				else
				{
					this.queuedMessages.unshift(this.messagesSending.pop());
				}
			}


			this.isSending = false;
			this.isAggregatingMessages = false;
			//Reopen the connection
			this.ConnectUSBGateway();
		}
	}
}

module.exports = SelveUSBGateway;