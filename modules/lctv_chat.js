// This is where we require the node-xmpp modules
// which allow us to connect to LCTV's Jabba/XMPP
// chats
var xmpp = require("node-xmpp-client");
var ltx = require("node-xmpp-core").ltx;

/**
 * Connect the XMPP client
 *
 * @param {Object|string} config_or_username
 * @param {String}        password
 * @param {String|Array}  channels array of channels or comma separated list
 * @param {String}        command_prefix default `!`, if not given in the config
 * @param {Bool}          include_self default false, should the bot emit events for itself
 *
 * @returns {chat_connector}
 */
function chat_connector(config_or_username, password, channels, command_prefix, include_self) {

    var self = this;

    // These arrays and the object store the users of the chat.
    // The object stores the usernames as keys and mod state as
    // the respective values, while the arrays just split them
    // depending on ranks
    this.userlist = {};
    this.mods = {};
    this.users = {};

    // The first argument of chat_connector can either be an object
    // containing the config values or a string containing the username
    // If it's an object, the script presumes all the information to
    // come from there
    var username = config_or_username;
    // Set a few default values for the "unimportant" options, just to
    // make sure
    command_prefix = command_prefix || "!";
    include_self = include_self || false;
    if (typeof config_or_username === "object") {
        username = config_or_username.username;
        password = config_or_username.password;
        channel = config_or_username.channel;
        command_prefix = config_or_username.command_prefix || "!";
        include_self = config_or_username.include_self || false;
    }

    // Instantiate a new LCTV Chat connection
    this.client = new xmpp({
        jid     : username + "@livecoding.tv",
        password: password
    });

    /**
     * Join a channel
     * @param channel
     */
    this.join = function (channel) {
        // The channel always needs to have the host name as well, so
        // we add that if it doesn't
        if (channel.indexOf("@chat.livecoding.tv") === -1) {
            channel += "@chat.livecoding.tv";
        }

        var join_data = new ltx.Element("presence", {
            to: channel + "/" + username
        }).c("x", {xmlns: 'http://jabber.org/protocol/muc'});

        self.client.send(join_data);
    };

    // We emit an online event once the chat connects to the server
    // and at the same time join the channel that has been specified
    this.client.on("online", function () {
        if (typeof channels === "string" || channels instanceof String) {
            if (channels.indexOf(",") !== -1) {
                channels = channels.split(",");
            } else {
                channels = [channels];
            }
        }

        channels.forEach(function (channel) {
            self.join(channel);
        });

        self.emit("online", channels);
    });

    // We just got some information from the server! Time to read it
    // and decide what to do with it. Again, we emit the same event
    // the xmpp client does, in case we need to hook it later on.
    this.client.on("stanza", function (stanza) {
        self.emit("stanza", stanza);

        if (stanza.type === "error") {
            self.emit("error", stanza);
            return;
        }

        var from = stanza.attrs.from;
        var channel = from.substring(0, from.indexOf("@chat.livecoding.tv"));

        if (stanza.type !== "chat") {
            from = from.substring(from.indexOf("/") + 1);
        }

        if (!include_self && (from.toLowerCase() === username.toLowerCase())) {
            return;
        }

        switch (stanza.name) {
            // We got a new message here, which could either be a command
            // or just a normal message. We have to check further down
            case "message":
                // The stanza might be empty, this happens when a mod uses the
                // /clear command. There's nothing here in this case, so just skip
                // Or if the message is a replay (Do not process them)
                var body_is_empty = typeof stanza.getChild("body") === "undefined";
                var message_is_a_replay = typeof stanza.getChild("delay") !== "undefined";

                if (body_is_empty || message_is_a_replay) {
                    return;
                }

                // Time to parse the message we got
                var message = stanza.getChild("body").children.toString();
                if (message.indexOf(command_prefix) === 0) { // Check if someone entered a command
                    var msg_split = message.split(" ");
                    msg_split[0] = msg_split[0].substring(1);
                    var command = msg_split.splice(0, 1)[0];
                    // We emit 2 types of commands, just for convenience
                    // With 1 you can listen to all commands and have to
                    // check which one it is yourself, the other just fires
                    // on the proper command you want.
                    self.emit("command", channel, command, from, msg_split);
                    self.emit("command#" + command, channel, from, msg_split);
                } else {
                    self.emit("message", channel, from, message);
                }
                break;
            // Presence stanzas are being sent when someone comes on or goes off.
            // This is where the server also tells us if the user is a mod or not
            case "presence":
                // ...and the mod powers
                var affiliation = stanza.getChild("x").getChild("item").attrs.affiliation;
                var is_admin = (affiliation === "admin" || affiliation === "owner");

                // This means the client has left, remove him from the right
                // user array and object
                var client_has_left = typeof stanza.attrs.type !== "undefined" && stanza.attrs.type === "unavailable";

                if (client_has_left) {
                    self.emit("part", channel, from, is_admin);
                    delete self.userlist[channel][from];
                    if (is_admin) {
                        var index = self.mods[channel].indexOf(from);
                        if (index > -1) {
                            self.mods[channel].splice(index, 1);
                        }
                        self.emit("admin_part", channel, from);
                    } else {
                        var index = self.users[channel].indexOf(from);
                        if (index > -1) {
                            self.users[channel].splice(index, 1);
                        }
                        self.emit("user_part", channel, from);
                    }
                    // And this is if a user joins. Here we add him to the array and object
                } else {
                    self.emit("join", channel, from, is_admin);
                    self.userlist[channel] = self.userlist[channel] || {};
                    self.userlist[channel][from] = is_admin;
                    if (is_admin) {
                        self.mods[channel] = self.mods[channel] || [];
                        self.mods[channel].push(from);
                        self.emit("admin_join", channel, from);
                    } else {
                        self.users[channel] = self.users[channel] || [];
                        self.users[channel].push(from);
                        self.emit("user_join", channel, from);
                    }
                }
                break;
        }
    });

    // The XMPP client shut down, we'll just emit an event
    this.client.on("end", function () {
        self.emit("end");
    });

    // The function that allows to send a message to the chat.
    this.say = function (channel, message) {
        if (channel.indexOf("@chat.livecoding.tv") === -1) {
            channel += "@chat.livecoding.tv";
        }

        var stanza = new ltx.Element("message", {
            to  : channel,
            type: "groupchat",
            from: username + "@livecoding.tv"
        }).c("body").t(message);
        self.client.send(stanza);
    }

    this.clear = function (channel) {
        if (channel.indexOf("@chat.livecoding.tv") === -1) {
            channel += "@chat.livecoding.tv";
        }

        var stanza = new ltx.Element("message", {
            to  : channel,
            type: "groupchat",
            from: username + "@livecoding.tv"
        }).c("clear", {
            xmlns: "https://www.livecoding.tv/xmpp/muc#admin"
        });
        self.client.send(stanza);
    }

    return this;
}
// We turn the chat_connector into a proper EventEmitter
require("util").inherits(chat_connector, require('events').EventEmitter);

module.exports = chat_connector;
