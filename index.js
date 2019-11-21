var Service;
var Characteristic;
var request = require("request");
var pollingtoevent = require('polling-to-event');
var wol = require('wake_on_lan');

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-philipstv-enhanced", "PhilipsTV", HttpStatusAccessory);
}

function HttpStatusAccessory(log, config) {
    this.log = log;
    var that = this;

    // CONFIG
    this.ip_address = config["ip_address"];
    this.name = config["name"];
    this.poll_status_interval = config["poll_status_interval"] || "0";
    this.model_year = config["model_year"] || "2018";
    this.wol_url = config["wol_url"] || "";
    this.model_year_nr = parseInt(this.model_year);
    this.set_attempt = 0;
    this.has_ambilight = config["has_ambilight"] || false;
    this.has_ssl = config["has_ssl"] || false;

    // CREDENTIALS FOR API
    this.username = config["username"] || "";
    this.password = config["password"] || "";

    // CHOOSING API VERSION BY MODEL/YEAR
    if (this.model_year_nr >= 2016) {
        this.api_version = 6;
    } else if (this.model_year_nr >= 2014) {
        this.api_version = 5;
    } else {
        this.api_version = 1;
    }

    // CONNECTION SETTINGS
    this.protocol = this.has_ssl ? "https" : "http";
    this.portno = this.has_ssl ? "1926" : "1925";
    this.need_authentication = this.username != '' ? 1 : 0;

    this.log("Model year: " + this.model_year_nr);
    this.log("API version: " + this.api_version);

    this.state_power = true;
    this.state_ambilight = false;
    this.state_ambilightLevel = 0;

    // Define URL & JSON Payload for Actions

    // POWER
    this.power_url = this.protocol + "://" + this.ip_address + ":" + this.portno + "/" + this.api_version + "/input/key";
    this.toggle_power_body = JSON.stringify({
        "key": "Standby"
    });

    // AMBILIGHT
    this.ambilight_status_url = this.protocol + "://" + this.ip_address + ":" + this.portno + "/" + this.api_version + "/menuitems/settings/current";
	this.ambilight_brightness_body = JSON.stringify({"nodes":[{"nodeid":200}]});
	this.ambilight_mode_body = JSON.stringify({"nodes":[{"nodeid":100}]});
	
    this.ambilight_config_url = this.protocol + "://" + this.ip_address + ":" + this.portno + "/" + this.api_version + "/menuitems/settings/update";
    this.ambilight_power_on_body = JSON.stringify({"value":{"Nodeid":100,"Controllable":true,"Available":true,"data":{"activenode_id":120}}}); // Follow Video 
    this.ambilight_power_off_body = JSON.stringify({"value":{"Nodeid":100,"Controllable":true,"Available":true,"data":{"activenode_id":110}}}); // Off

    // POLLING ENABLED?
    this.interval = parseInt(this.poll_status_interval);
    this.switchHandling = "check";
    if (this.interval > 10 && this.interval < 100000) {
        this.switchHandling = "poll";
    }

    // STATUS POLLING
    if (this.switchHandling == "poll") {
        var statusemitter = pollingtoevent(function(done) {
            that.getPowerState(function(error, response) {
                done(error, response, that.set_attempt);
            }, "statuspoll");
        }, {
            longpolling: true,
            interval: that.interval * 1000,
            longpollEventName: "statuspoll_power"
        });

        statusemitter.on("statuspoll_power", function(data) {
            that.state_power = data;
            if (that.switchService) {
                that.switchService.getCharacteristic(Characteristic.On).setValue(that.state_power, null, "statuspoll");
            }
        });

        if (this.has_ambilight) {
            var statusemitter_ambilight = pollingtoevent(function(done) {
                that.getAmbilightState(function(error, response) {
                    done(error, response, that.set_attempt);
                }, "statuspoll");
            }, {
                longpolling: true,
                interval: that.interval * 1000,
                longpollEventName: "statuspoll_ambilight"
            });

            statusemitter_ambilight.on("statuspoll_ambilight", function(data) {
                that.state_ambilight = data;
                if (that.ambilightService) {
                    that.ambilightService.getCharacteristic(Characteristic.On).setValue(that.state_ambilight, null, "statuspoll");
                }
            });
            
            var statusemitter_ambilight_brightness = pollingtoevent(function(done) {
                that.getAmbilightBrightness(function(error, response) {
                    done(error, response, that.set_attempt);
                }, "statuspoll");
            }, {
                longpolling: true,
                interval: that.interval * 1000,
                longpollEventName: "statuspoll_ambilight_brightness"
            });

            statusemitter_ambilight_brightness.on("statuspoll_ambilight_brightness", function(data) {
                that.state_ambilight_brightness = data;
                if (that.ambilightService) {
                    that.ambilightService.getCharacteristic(Characteristic.Brightness).setValue(that.state_ambilight_brightness, null, "statuspoll");
                }
            });            
            
            
        }
    }
}

/////////////////////////////

HttpStatusAccessory.prototype = {

	// Sometime the API fail, all calls should use a retry method, not used yet but goal is to replace all the XLoop function by this generic one
    httpRequest_with_retry: function(url, body, method, need_authentication, retry_count, callback) {
        this.httpRequest(url, body, method, need_authentication, function(error, response, responseBody) {
            if (error) {
                if (retry_count > 0) {
                    this.log('Got error, will retry: ', retry_count, ' time(s)');
                    this.httpRequest_with_retry(url, body, method, need_authentication, retry_count - 1, function(err) {
                        callback(err);
                    });
                } else {
                    this.log('Request failed: %s', error.message);
                    callback(new Error("Request attempt failed"));
                }
            } else {
                this.log('succeeded - answer: %s', responseBody);
                callback(null, response, responseBody);
            }
        }.bind(this));
    },

    httpRequest: function(url, body, method, need_authentication, callback) {
        var options = {
            url: url,
            body: body,
            method: method,
            rejectUnauthorized: false,
            timeout: 1000
        };

        // EXTRA CONNECTION SETTINGS FOR API V6 (HTTP DIGEST)
        if (need_authentication) {
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
        	}
        );
    },

    wolRequest: function(url, callback) {
        this.log('calling WOL with URL %s', url);
        if (!url) {
            callback(null, "EMPTY");
            return;
        }
        if (url.substring(0, 3).toUpperCase() == "WOL") {
            //Wake on lan request
            var macAddress = url.replace(/^WOL[:]?[\/]?[\/]?/ig, "");
            this.log("Excuting WakeOnLan request to " + macAddress);
            wol.wake(macAddress, function(error) {
                if (error) {
                    callback(error);
                } else {
                    callback(null, "OK");
                }
            });
        } else {
            if (url.length > 3) {
                callback(new Error("Unsupported protocol: ", "ERROR"));
            } else {
                callback(null, "EMPTY");
            }
        }
    },

    // POWER FUNCTIONS
    setPowerStateLoop: function(nCount, url, body, powerState, callback) {
        var that = this;

        that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            if (error) {
                if (nCount > 0) {
                    that.log('setPowerStateLoop - powerstate attempt, attempt id: ', nCount - 1);
                    that.setPowerStateLoop(nCount - 1, url, body, powerState, function(err, state_power) {
                        callback(err, state_power);
                    });
                } else {
                    that.log('setPowerStateLoop - failed: %s', error.message);
                    powerState = false;
                    callback(new Error("HTTP attempt failed"), powerState);
                }
            } else {
                that.log('setPowerStateLoop - Succeeded - current state: %s', powerState);
                callback(null, powerState);
            }
        });
    },

    setPowerState: function(powerState, callback, context) {
        var url = this.power_url;
        var body;
        var that = this;

		this.log.debug("Entering %s with context: %s and target value: %s", arguments.callee.name, context, powerState);

        if (context && context == "statuspoll") {
				callback(null, powerState);
				return;
        }

        this.set_attempt = this.set_attempt + 1;

        if (powerState) {
            if (this.model_year_nr <= 2013) {
                this.log("Power On is not possible for model_year before 2014.");
                callback(new Error("Power On is not possible for model_year before 2014."));
            }
            body = this.toggle_power_body;
            this.log("setPowerState - Will power on");
			// If Mac Addr for WOL is set
			if (this.wol_url) {
				that.log('setPowerState - Sending WOL');
				this.wolRequest(this.wol_url, function(error, response) {
					that.log('setPowerState - WOL callback response: %s', response);
					that.log('setPowerState - powerstate attempt, attempt id: ', 8);
					//execute the callback immediately, to give control back to homekit
					callback(error, that.state_power);
					that.setPowerStateLoop(8, url, body, powerState, function(error, state_power) {
						that.state_power = state_power;
						if (error) {
							that.state_power = false;
							that.log("setPowerStateLoop - ERROR: %s", error);
							if (that.powerService) {
								that.powerService.getCharacteristic(Characteristic.On).setValue(that.state_power, null, "statuspoll");
							}
						}
					});
				}.bind(this));
			} 
        } else {
            body = this.toggle_power_body;
            this.log("setPowerState - Will power off");
            that.setPowerStateLoop(0, url, body, powerState, function(error, state_power) {
                that.state_power = state_power;
                if (error) {
                    that.state_power = false;
                    that.log("setPowerStateLoop - ERROR: %s", error);
                }
                if (that.powerService) {
                    that.powerService.getCharacteristic(Characteristic.On).setValue(that.state_power, null, "statuspoll");
                }
                if (that.ambilightService) {
                    that.state_ambilight = false;
                    that.ambilightService.getCharacteristic(Characteristic.On).setValue(that.state_ambilight, null, "statuspoll");
                }
                callback(error, that.state_power);
            }.bind(this));
        }
    },

    getPowerState: function(callback, context) {
        var that = this;
        var url = this.power_url;
        
        
   		this.log.debug("Entering %s with context: %s and current value: %s", arguments.callee.name, context, this.state_power);
        //if context is statuspoll, then we need to request the actual value else we return the cached value
		if ((!context || context != "statuspoll") && this.switchHandling == "poll") {
            callback(null, this.state_power);
            return;
        }

        this.httpRequest(url, "", "GET", this.need_authentication, function(error, response, responseBody) {
            var tResp = that.state_power;
            var fctname = "getPowerState";
            if (error) {
                that.log('%s - ERROR: %s', fctname, error.message);
                that.state_power = false;
            } else {
                if (responseBody) {
                    var responseBodyParsed;
                    try {
                        responseBodyParsed = JSON.parse(responseBody);
                        if (responseBodyParsed && responseBodyParsed.powerstate) {
                        	tResp = (responseBodyParsed.powerstate == "On") ? 1 : 0;
						} else {
		                    that.log("%s - Could not parse message: '%s', not updating state", fctname, responseBody);
						}
                    } catch (e) {
                        that.log("%s - Got non JSON answer - not updating state: '%s'", fctname, responseBody);
                    }
                }
                if (that.state_power != tResp) {
                    that.log('%s - Level changed to: %s', fctname, tResp);
	                that.state_power = tResp;
                }
            }
            callback(null, that.state_power);
        }.bind(this));
    },

    // AMBILIGHT FUNCTIONS
    setAmbilightStateLoop: function(nCount, url, body, ambilightState, callback) {
        var that = this;

        that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            if (error) {
                if (nCount > 0) {
                    that.log('setAmbilightStateLoop - attempt, attempt id: ', nCount - 1);
                    that.setAmbilightStateLoop(nCount - 1, url, body, ambilightState, function(err, state) {
                        callback(err, state);
                    });
                } else {
                    that.log('setAmbilightStateLoop - failed: %s', error.message);
                    ambilightState = false;
                    callback(new Error("HTTP attempt failed"), ambilightState);
                }
            } else {
                that.log('setAmbilightStateLoop - succeeded - current state: %s', ambilightState);
                callback(null, ambilightState);
            }
        });
    },

    setAmbilightState: function(ambilightState, callback, context) {
		this.log.debug("Entering setAmbilightState with context: %s and requested value: %s", context, ambilightState);
        var url;
        var body;
        var that = this;

        //if context is statuspoll, then we need to ensure that we do not set the actual value
        if (context && context == "statuspoll") {
            callback(null, ambilightState);
            return;
        }

        this.set_attempt = this.set_attempt + 1;

        if (ambilightState) {
            url = this.ambilight_config_url;
            body = this.ambilight_power_on_body;
            this.log("setAmbilightState - setting state to on");
        } else {
            url = this.ambilight_config_url;
            body = this.ambilight_power_off_body;
            this.log("setAmbilightState - setting state to off");
        }

        that.setAmbilightStateLoop(0, url, body, ambilightState, function(error, state) {
            that.state_ambilight = ambilightState;
            if (error) {
                that.state_ambilight = false;
                that.log("setAmbilightState - ERROR: %s", error);
                if (that.ambilightService) {
                    that.ambilightService.getCharacteristic(Characteristic.On).setValue(that.state_ambilight, null, "statuspoll");
                }
            }
            callback(error, that.state_ambilight);
        }.bind(this));
    },

    getAmbilightState: function(callback, context) {
        var that = this;
        var url = this.ambilight_status_url;
        var body = this.ambilight_mode_body;

		this.log.debug("Entering %s with context: %s and current value: %s", arguments.callee.name, context, this.state_ambilight);
        //if context is statuspoll, then we need to request the actual value
		if ((!context || context != "statuspoll") && this.switchHandling == "poll") {
            callback(null, this.state_ambilight);
            return;
        }
        if (!this.state_power) {
                callback(null, false);
                return;
        }

        this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            var tResp = that.state_ambilight;
            var fctname = "getAmbilightState";
            if (error) {
                that.log('%s - ERROR: %s', fctname, error.message);
            } else {
                if (responseBody) {
	                var responseBodyParsed;
                    try {
						responseBodyParsed = JSON.parse(responseBody);
						if (responseBodyParsed && responseBodyParsed.values[0].value.data.activenode_id) {
							tResp = (responseBodyParsed.values[0].value.data.activenode_id == 110) ? false : true;
							that.log.debug('%s - got answer %s', fctname, tResp);
						} else {
		                    that.log("%s - Could not parse message: '%s', not updating state", fctname, responseBody);
						}
					} catch (e) {
                        that.log("%s - Got non JSON answer - not updating state: '%s'", fctname, responseBody);
                    }
                }
                if (that.state_ambilight != tResp) {
                    that.log('%s - state changed to: %s', fctname, tResp);
	                that.state_ambilight = tResp;
                }
            }
            callback(null, that.state_ambilight);
        }.bind(this));
    },

    setAmbilightBrightnessLoop: function(nCount, url, body, ambilightLevel, callback) {
        var that = this;

        that.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            if (error) {
                if (nCount > 0) {
                    that.log('setAmbilightStateLoop - attempt, attempt id: ', nCount - 1);
                    that.setAmbilightBrightnessLoop(nCount - 1, url, body, ambilightLevel, function(err, state) {
                        callback(err, state);
                    });
                } else {
                    that.log('setAmbilightBrightnessLoop - failed: %s', error.message);
                    ambilightLevel = false;
                    callback(new Error("HTTP attempt failed"), ambilightLevel);
                }
            } else {
                that.log('setAmbilightBrightnessLoop - succeeded - current state: %s', ambilightLevel);
                callback(null, ambilightLevel);
            }
        });
    },

    setAmbilightBrightness: function(ambilightLevel, callback, context) {
		var TV_Adjusted_ambilightLevel = Math.round(ambilightLevel / 10);
        var url = this.ambilight_config_url;
        var body = JSON.stringify({"value":{"Nodeid":200,"Controllable":true,"Available":true,"data":{"value":TV_Adjusted_ambilightLevel}}});
        var that = this;

 		this.log.debug("Entering setAmbilightBrightness with context: %s and requested value: %s", context, ambilightLevel);
        //if context is statuspoll, then we need to ensure that we do not set the actual value
        if (context && context == "statuspoll") {
            callback(null, ambilightLevel);
            return;
        }

        this.set_attempt = this.set_attempt + 1;

        that.setAmbilightBrightnessLoop(0, url, body, ambilightLevel, function(error, state) {
            that.state_ambilightLevel = ambilightLevel;
            if (error) {
                that.state_ambilightLevel = false;
                that.log("setAmbilightBrightness - ERROR: %s", error);
                if (that.ambilightService) {
                    that.ambilightService.getCharacteristic(Characteristic.On).setValue(that.state_ambilightLevel, null, "statuspoll");
                }
            }
            callback(error, that.state_ambilightLevel);
        }.bind(this));
    },

    getAmbilightBrightness: function(callback, context) {
        var that = this;
        var url = this.ambilight_status_url;
        var body = this.ambilight_brightness_body;

		this.log.debug("Entering %s with context: %s and current value: %s", arguments.callee.name, context, this.state_ambilightLevel);
        //if context is statuspoll, then we need to request the actual value
		if ((!context || context != "statuspoll") && this.switchHandling == "poll") {
            callback(null, this.state_ambilightLevel);
            return;
        }
        if (!this.state_power) {
                callback(null, 0);
                return;
        }

        this.httpRequest(url, body, "POST", this.need_authentication, function(error, response, responseBody) {
            var tResp = that.state_ambilightLevel;
            var fctname = "getAmbilightBrightness";
            if (error) {
                that.log('%s - ERROR: %s', fctname, error.message);
            } else {
                if (responseBody) {
	                var responseBodyParsed;
                    try {
						responseBodyParsed = JSON.parse(responseBody);
						if (responseBodyParsed && responseBodyParsed.values[0].value.data) {
							tResp = 10*responseBodyParsed.values[0].value.data.value;
							that.log.debug('%s - got answer %s', fctname, tResp);
						} else {
		                    that.log("%s - Could not parse message: '%s', not updating level", fctname, responseBody);
						}
					} catch (e) {
                        that.log("%s - Got non JSON answer - not updating level: '%s'", fctname, responseBody);
                    }
                }
                if (that.state_ambilightLevel != tResp) {
                    that.log('%s - Level changed to: %s', fctname, tResp);
	                that.state_ambilightLevel = tResp;
                }
            }
            callback(null, that.state_ambilightLevel);
        }.bind(this));
    },

    identify: function(callback) {
        this.log("Identify requested!");
        callback(); // success
    },

    getActiveIdentifier: function(callback) {
        callback(null, 1);
    },

    setActiveIdentifier: function(identifier, callback){
        callback(null, identifier);
    },

    getServices: function() {
        var that = this;

        var informationService = new Service.AccessoryInformation();
        informationService
            .setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.Manufacturer, 'Philips')
            .setCharacteristic(Characteristic.Model, this.model_year);

        // POWER
        this.powerService = new Service.Switch(this.name + " Power", '0a');
        this.powerService
            .getCharacteristic(Characteristic.On)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.setPowerState.bind(this));

        if (this.has_ambilight) {
            // AMBILIGHT
            this.ambilightService = new Service.Lightbulb(this.name + " Ambilight", '0e');
            this.ambilightService
                .getCharacteristic(Characteristic.On)
                .on('get', this.getAmbilightState.bind(this))
                .on('set', this.setAmbilightState.bind(this));

        	this.ambilightService
            	.getCharacteristic(Characteristic.Brightness)
            	.on('get', this.getAmbilightBrightness.bind(this))
            	.on('set', this.setAmbilightBrightness.bind(this));

            return [informationService, this.ambilightService, this.powerService];
        } else {
            return [informationService, this.powerService];
        }
    }
};