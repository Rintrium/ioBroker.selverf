class GatewayCommand {
	/**
	 * @param splitID: Splitted (by '.') id of the change state (Array of strings)
     * @param val: The value of the changed state
	 */
	constructor(splitID, val) {

		this.splitID = splitID;
		this.val = val;
		this.clearedOnce = false;
	}

	/**
     *
     * @param {boolean} waitForExtraReponse : if the adapter needs to wait for more messages after the MethodReponse from the gateway before sending more messages
     * @param {number} identifier : when a device command is sent this is used to identify the correct GatewayCommand for a response or event
     *
     */
	PrepareForSendingQueue(waitForExtraReponse, identifier)
	{
		this.waitForExtraResponse = waitForExtraReponse;
		this.identifier = identifier;
	}



}

module.exports = GatewayCommand;