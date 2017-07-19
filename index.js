var Service;
var Characteristic;
var request = require("request");
var pollingtoevent = require('polling-to-event');
var wol = require('wake_on_lan');

module.exports = function(homebridge)
{
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-philipstv", "PhilipsTV", HttpStatusAccessory);
}

function HttpStatusAccessory(log, config) 
{
	this.log = log;
	var that = this;
	
	// CONFIG
	this.ip_address	= config["ip_address"];
	this.name = config["name"];
	this.poll_status_interval = config["poll_status_interval"] || "0";
	this.model_year = config["model_year"] || "2014";
	this.wol_url = config["wol_url"] || "";
	this.model_year_nr = parseInt(this.model_year);
	this.set_attempt = 0;
	
	// CREDENTIALS FOR API
	this.username = config["username"] || "";
	this.password = config["password"] || "";
	
	// CHOOSING API VERSION BY MODEL/YEAR
	switch (this.model_year_nr) {
		case 2016:
			this.api_version = 6;
			break;
		case 2014:
			this.api_version = 5;
			break;
		default:
			this.api_version = 1;
	}
	
	// CONNECTION SETTINGS
	this.protocol = (this.api_version > 5)?"https":"http";
	this.portno = (this.api_version > 5)?"1926":"1925";
	
	that.log("Model year: "+this.model_year_nr);
	that.log("API version: "+this.api_version);
	
	
	this.states = {};
	this.states["power"] = false;
	this.states["ambilight"] = false;
	
	this.statusUrls = {};
	this.statusUrls["power"] = this.protocol+"://"+this.ip_address+":"+this.portno+"/"+this.api_version+"/powerstate";
	this.statusUrls["ambilight"] = this.protocol+"://"+this.ip_address+":"+this.portno+"/"+this.api_version+"/ambilight/power";
	
	this.onUrls = {};
	this.onUrls["power"] = this.statusUrls["power"];
	this.onUrls["ambilight"] = this.protocol+"://"+this.ip_address+":"+this.portno+"/"+this.api_version+"/ambilight/currentconfiguration";
	
	this.onBodies = {};
	this.onBodies["power"] = JSON.stringify({"powerstate":"On"});
	this.onBodies["ambilight"] = JSON.stringify({"styleName":"FOLLOW_VIDEO","isExpert":false,"menuSetting":"NATURAL"});
	
	this.offUrls = {};
	this.offUrls["power"] = this.onUrls["power"]
	this.offUrls["ambilight"] = this.statusUrls["ambilight"]
	
	this.offBodies = {};
	this.offBodies["power"] = JSON.stringify({"powerstate":"Standby"});
	this.offBodies["ambilight"] = JSON.stringify({"power":"Off"});
	
	this.services = {};
	
	// INFOSET
	this.powerstateOnError = "0";
	this.powerstateOnConnect = "1";
	this.info = {
		serialnumber : "Unknown",
		model : "Unknown",
		manufacterer : "Philips",
		name : "not provided",
		softwareversion : "Unknown"
	};
	
	// POLLING ENABLED?
	this.interval = parseInt( this.poll_status_interval);
	this.switchHandling = "check";
	if (this.interval > 10 && this.interval < 100000) {
		this.switchHandling = "poll";
	}
	
	// STATUS POLLING
	if (this.switchHandling == "poll") {
		
		var statusemitter_power = pollingtoevent(function(done) {
			that.getStates( function( error, response) {
				done(error, response, that.set_attempt);
			}, "statuspoll","power");
		}, {longpolling:true,interval:that.interval * 1000,longpollEventName:"statuspoll_power"});

		statusemitter_power.on("statuspoll_power", function(data) {
			that.state = data;
			if (that.services["power"] ) {
				that.services["power"].getCharacteristic(Characteristic.On).setValue(that.states["power"], null, "statuspoll");
			}
		});
		
		var statusemitter_ambilight = pollingtoevent(function(done) {
			that.getStates( function( error, response) {
				done(error, response, that.set_attempt);
			}, "statuspoll","ambilight");
		}, {longpolling:true,interval:that.interval * 1000,longpollEventName:"statuspoll_ambilight"});

		statusemitter_ambilight.on("statuspoll_ambilight", function(data) {
			that.state = data;
			if (that.services["ambilight"] ) {
				that.services["ambilight"].getCharacteristic(Characteristic.On).setValue(that.states["ambilight"], null, "statuspoll");
			}
		});
	}
}

HttpStatusAccessory.prototype = {

httpRequest: function(url, body, method, api_version, callback) {
	var options = {
		url: url,
		body: body,
		method: method,
		rejectUnauthorized: false,
		timeout: 3000
	};
	
	// EXTRA CONNECTION SETTINGS FOR API V6 (HTTP DIGEST)
	if(api_version == 6) {
		options.followAllRedirects = true;
		options.forever = true;
		options.auth = {
			user: this.username,
			pass: this.password,
			sendImmediately: false
		}
	}
	
	req = request(options,
	function(error, response, body) {
		callback(error, response, body)
	});
},

identify: function(callback) {
    this.log("Identify requested!");
    callback(); // success
},

setStatesLoop: function(nCount, url, body, state, callback)
{
	var that = this;

	that.httpRequest(url, body, "POST", this.api_version, function(error, response, responseBody) {
		if (error) {
			if (nCount > 0) {
				that.setStatesLoop(nCount-1, url, body, state, function( err, rState) {
					callback(err, rState);
				});				
			} else {
				callback(new Error("HTTP attempt failed"), false);
			}
		} else {
			callback(null, state);
		}
	});
},

setStates: function(state, callback, context, mode) {
    var url;
    var body;
	var that = this;

	//if context is statuspoll, then we need to ensure that we do not set the actual value
	if (context && context == "statuspoll") {
		callback(null, state);
	    return;
	}
    if (!this.ip_address) {
    	this.log.warn("Ignoring request; No ip_address defined.");
	    callback(new Error("No ip_address defined."));
	    return;
    }

	this.set_attempt = this.set_attempt+1;
	
    if (state) {
		url = this.onUrls[mode];
		body = this.onBodies[mode];
    } else {
		url = this.offUrls[mode];
		body = this.offBodies[mode];
    }

	that.setStatesLoop( 0, url, body, state, function( error, state) {
		that.states[mode] = state;
		if (error) {
			that.states[mode] = that.powerstateOnError;
			if (that.services[mode] ) {
				that.services[mode].getCharacteristic(Characteristic.On).setValue(that.states[mode], null, "statuspoll");
			}					
		}
		callback(error, that.states[mode]);
	}.bind(this));
},

getStates: function(callback, context, type) {
	var that = this;
	//if context is statuspoll, then we need to request the actual value
	if (!context || context != "statuspoll") {
		console.log("get %s from cache", type);
		if (this.switchHandling == "poll") {
			callback(null, this.states[type]);
			return;
		}
	}
	
    if (!this.statusUrls[type]) {
    	this.log.warn("Ignoring request; No "+type+" status url defined.");
	    callback(new Error("No "+type+" status url defined."));
	    return;
    }
    
    var url = this.statusUrls[type];

    this.httpRequest(url, "", "GET", this.api_version, function(error, response, responseBody) {
		var state = that.powerstateOnError;
		var tError = error;
		if (!tError) {
			var parsed = false;
			if (responseBody) {
				var responseBodyParsed = JSON.parse( responseBody);
				if (responseBodyParsed && responseBodyParsed.power) {
					if (responseBodyParsed.power == "On") {
						state = that.powerstateOnConnect;
					} else {
						state = that.powerstateOnError;
					}
					parsed = true;
				}
			}
			if (!parsed) {
				that.log("Could not parse message: '%s'", responseBody);
				if (that.powerstateOnError) {
				  state = that.powerstateOnError;
				  tError = null;
				}
			}
		}
		
		if (tError) {
			that.log("getState %s failed - actual mode - current state: %s, error: %s", type, state, error.message);
		} else {
			var binaryState = parseInt(state);
			state = binaryState > 0;
			that.log("getState %s - actual mode - current state: %s", type, state);
		}
		that.states[type] = state;
		callback((tError)?true:false, state);
		
	}.bind(this));
},

getServices: function() {
	var that = this;

	var informationService = new Service.AccessoryInformation();
    	informationService.setCharacteristic(Characteristic.Name, this.name)
    	informationService.setCharacteristic(Characteristic.Manufacturer, 'Philips');

	// POWER
	var switchService = new Service.Switch(this.name);
	switchService
		.getCharacteristic(Characteristic.On)
		.on('get', function(callback){
			this.getStates(callback,'','power');
		}.bind(this))
		.on('set', function(state, callback){
			this.setStates(state, callback,'','power');
		}.bind(this));
		
	this.services["power"] = switchService;

		
	// AMBILIGHT
	var ambilightService = new Service.Lightbulb(this.name+" Ambilight");
	ambilightService
		.getCharacteristic(Characteristic.On)
		.on('get', function(callback){
			this.getStates(callback,'','ambilight');
		}.bind(this))
		.on('set', function(state, callback){
			this.setStates(state, callback,'','ambilight');
		}.bind(this));
		
	this.services["ambilight"] = ambilightService;

	return [informationService, this.services["power"], this.services["ambilight"]];
}
};
