class GatewayCommand {
    /**
	 * @param splitID: Splitted (by '.') id of the change state
     * @param val: The value of the changed state
	 */
    constructor(splitID, val) {

		this.splitID = splitID;
        this.val = val;

        
	}
}

module.exports = GatewayCommand;