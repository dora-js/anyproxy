try{
    global.util = require('./lib/util');
}catch(e){}

var http = require('http'),
    https           = require('https'),
    fs              = require('fs'),
    async           = require("async"),
    url             = require('url'),
    color           = require('colorful'),
    certMgr         = require("./lib/certMgr"),
    requestHandler  = require("./lib/requestHandler"),
    Recorder        = require("./lib/recorder"),
    logUtil         = require("./lib/log"),
    util            = require("./lib/util"),
    path            = require("path"),
    events          = require("events"),
    ip              = require("ip"),
    ThrottleGroup   = require("stream-throttle").ThrottleGroup;

var T_TYPE_HTTP            = 0,
    T_TYPE_HTTPS           = 1,
    DEFAULT_PORT           = 8001,
    DEFAULT_WEB_PORT       = 8002, // port for web interface
    DEFAULT_WEBSOCKET_PORT = 8003, // internal web socket for web interface, not for end users
    DEFAULT_CONFIG_PORT    = 8088,
    DEFAULT_HOST           = "localhost",
    DEFAULT_TYPE           = T_TYPE_HTTP;

var default_rule = require('./lib/rule_default');

//option
//option.type     : 'http'(default) or 'https'
//option.port     : 8001(default)
//option.hostname : localhost(default)
//option.rule          : ruleModule
//option.webPort       : 8002(default)
//option.socketPort    : 8003(default)
//option.webConfigPort : 8088(default)
//option.dbFile        : null(default)
//option.throttle      : null(default)
//option.disableWebInterface
//option.silent        : false(default)
//option.interceptHttps ,internal param for https
function proxyServer(option){
    option = option || {};

    var self       = this,
        proxyType           = /https/i.test(option.type || DEFAULT_TYPE) ? T_TYPE_HTTPS : T_TYPE_HTTP ,
        proxyPort           = option.port     || DEFAULT_PORT,
        proxyHost           = option.hostname || DEFAULT_HOST,
        proxyRules          = option.rule     || default_rule,
        proxyWebPort        = option.webPort       || DEFAULT_WEB_PORT,       //port for web interface
        socketPort          = option.socketPort    || DEFAULT_WEBSOCKET_PORT, //port for websocket
        proxyConfigPort     = option.webConfigPort || DEFAULT_CONFIG_PORT,    //port to ui config server
        disableWebInterface = !!option.disableWebInterface,
        ifSilent            = !!option.silent,
        generateRootCA      = option.generateRootCA !== false, // default is true
        autoTrust           = !!option.autoTrust;

    this.cacheDirName = 'cache_' + Date.now();

    if(ifSilent){
        logUtil.setPrintStatus(false);
    }



    if(!!option.interceptHttps){
        default_rule.setInterceptFlag(true);

        //print a tip when using https features in Node < v0.12
        var nodeVersion = Number(process.version.match(/^v(\d+\.\d+)/)[1]);
        if(nodeVersion < 0.12){
            logUtil.printLog(color.red("node >= v0.12 is required when trying to intercept HTTPS requests :("), logUtil.T_ERR);
        }
    }

    if(option.throttle){
        logUtil.printLog("throttle :" + option.throttle + "kb/s");
        global._throttle = new ThrottleGroup({rate: 1024 * parseInt(option.throttle) }); // rate - byte/sec
    }

    requestHandler.setRules(proxyRules); //TODO : optimize calling for set rule
    self.httpProxyServer = null;

    var recorderOptions = {
        cacheDirName: self.cacheDirName
    };

    if(option.dbFile) {
        recorderOptions.filename = option.dbFile;
    }

    global.recorder = new Recorder(recorderOptions);

    async.series(
        [
            //creat proxy server
            function(callback){
                if(proxyType == T_TYPE_HTTPS){
                    certMgr.getCertificate(proxyHost,function(err,keyContent,crtContent){
                        if(err){
                            callback(err);
                        }else{
                            self.httpProxyServer = https.createServer({
                                key : keyContent,
                                cert: crtContent
                            },requestHandler.userRequestHandler);
                            callback(null);
                        }
                    });
                }else{
                    self.httpProxyServer = http.createServer(requestHandler.userRequestHandler);
                    callback(null);
                }
            },

            // generate root ca
            function(callback) {
                if(!generateRootCA || certMgr.isRootCAFileExists()) {
                    callback(null);
                    return;
                }
                certMgr.generateRootCA(callback);
            },

            // auto trust cert
            function(callback) {
                if (!autoTrust) {
                    logUtil.printLog(color.green(color.bold("please trust the rootCA.crt in " + certMgr.certDir)));
                    callback(null);
                    return;
                }
                certMgr.isRootCATrusted(function(trusted) {
                    if (trusted) {
                        callback(null);
                        return;
                    }
                    certMgr.trustRootCA(function(trusted) {
                        callback(null);
                    });
                })
            },

            //handle CONNECT request for https over http
            function(callback){
                self.httpProxyServer.on('connect',requestHandler.connectReqHandler);
                callback(null);
            },

            //start proxy server
            function(callback){
                self.httpProxyServer.listen(proxyPort);
                callback(null);
            },

            //server status manager
            function(callback){
                // process.stdin.resume();// so the program will not close instantly

                function exitHandler() {
                    logUtil.printLog('\nAnyProxy is about to exit');
                    util.clearCacheDir(self.cacheDirName, function() {
                      process.exit();
                    });
                }

                if (process.platform === 'win32') {
                    var rl = require('readline').createInterface({
                        input: process.stdin,
                        output: process.stdout,
                    });

                    rl.on('SIGINT', function() {
                        process.emit('SIGINT');
                    });
                }

                process.on('SIGINT', exitHandler);

                process.on('exit', function() {
                    process.exit();
                });

                process.on("uncaughtException",function(err){
                    logUtil.printLog('Caught exception: ' + (err.stack || err), logUtil.T_ERR);
                    util.clearCacheDir(self.cacheDirName, function() {
                        process.exit();
                    });
                });

                callback(null);
            }
        ],

        //final callback
        function(err,result){
            //if(!err){
            //    var tipText = (proxyType == T_TYPE_HTTP ? "Http" : "Https") + " proxy started at " + color.bold(ip.address() + ":" + proxyPort);
            //    logUtil.printLog(color.green(tipText));
            //}else{
            //    var tipText = "err when start proxy server :(";
            //    logUtil.printLog(color.red(tipText), logUtil.T_ERR);
            //    logUtil.printLog(err, logUtil.T_ERR);
            //}

            self.emit('finish', err, {
                isHTTP: proxyType === T_TYPE_HTTP,
            });
        }
    );

    self.close = function(){
        self.httpProxyServer && self.httpProxyServer.close();
        logUtil.printLog("server closed :" + proxyHost + ":" + proxyPort);
    }
}

require('util').inherits(proxyServer, require('events'));

module.exports.proxyServer        = proxyServer;
module.exports.trustRootCA        = certMgr.trustRootCA;
module.exports.isRootCATrusted    = certMgr.isRootCATrusted;
module.exports.generateRootCA     = certMgr.generateRootCA;
module.exports.isRootCAFileExists = certMgr.isRootCAFileExists;
module.exports.setRules           = requestHandler.setRules;
