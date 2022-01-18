"use strict";

const { Adapter } = require("@iobroker/adapter-core");
/*
 * Created with @iobroker/create-adapter v1.34.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const { log, info } = require("console");

const SelveUSBGateway       = require("./lib/SelveUSBGateway.js");


// Load your modules here, e.g.:
// const fs = require("fs");

class Selverf extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "selverf",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));

		this.gateway = new SelveUSBGateway(this);
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		this.setStateAsync("info.connection", { val: false, ack: true });

		this.gateway.eventEmitter.addListener("connected", this.onConnectionWithGateway.bind(this));
		this.gateway.eventEmitter.addListener("reconnected", this.onReconnectionWithGateway.bind(this));
		this.gateway.ConnectUSBGateway();
	}

	onConnectionWithGateway()
	{
		this.setStateAsync("info.connection", { val: true, ack: true });

		this.gateway.GetGatewayVersion();
		this.gateway.GetCommeoActuatorIDs();
		this.gateway.GetIveoActuatorIDs();
		this.gateway.GetSensorIDs();
		this.gateway.GetSenderIDs();
	}

	onReconnectionWithGateway()
	{
		this.setStateAsync("info.connection", { val: true, ack: true });
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {

			this.gateway.Unload();

			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			//this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

			//State changes without ack were not changed by this adapter, so they must be handled
			if (!state.ack) this.gateway.HandleSubscribedStateChange(id, state);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
	// 		}
	// 	}
	// }

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Selverf(options);
} else {
	// otherwise start the instance directly
	new Selverf();
}