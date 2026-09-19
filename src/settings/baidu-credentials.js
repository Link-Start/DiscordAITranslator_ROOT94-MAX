// Baidu's general text API uses APP ID + signing secret. Older versions stored
// two space-separated parts, or three parts with an unused middle value.
function readBaiduCredentials(auth = {}) {
	const text = value => typeof value == "string" ? value.trim() : "";
	if (Object.prototype.hasOwnProperty.call(auth, "appId") || Object.prototype.hasOwnProperty.call(auth, "secretKey")) {
		return {appId: text(auth.appId), secretKey: text(auth.secretKey)};
	}
	const parts = text(auth.key).split(/\s+/);
	return {appId: parts[0] || "", secretKey: parts.length == 2 ? parts[1] : parts.length == 3 ? parts[2] : ""};
}

function isBaiduCredentialComplete({appId, secretKey}) {
	return !!appId && !!secretKey && !/\s/.test(appId) && !/\s/.test(secretKey);
}

module.exports = {readBaiduCredentials, isBaiduCredentialComplete};
