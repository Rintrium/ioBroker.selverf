"use strict";


module.exports = {
	InitializeUSBGateway,
	ReturnPath
};

let usbGatewayPath;


//USB Path: String mit Pfadangabe zum USB Gateway
async function InitializeUSBGateway(usbPathAsString)
{
	usbGatewayPath = usbPathAsString;
	return Promise.resolve();
}

function ReturnPath()
{
	return usbGatewayPath;
}