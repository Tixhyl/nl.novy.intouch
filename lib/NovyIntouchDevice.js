"use strict";

// Destructure RFDevice + util from homey-rfdriver
const { RFDevice, util } = require("homey-rfdriver");
const Signal = require("../../lib/NovyIntouchSignal");

module.exports = class NovyIntouchDevice extends RFDevice {
  /**
   * SDK v3 entry point for a Device instance.
   */
  async onInit() {
    await super.onInit();

    this.log("NovyIntouchDevice has been initialized (SDK v3).");

    // Load settings into an internal property so we can handle them easily
    this._settings = this.getSettings();
  }

  /**
   * Called when device settings are updated from the Homey UI.
   */
  async onSettings(oldSettingsObj, newSettingsObj, changedKeysArr) {
    this.log("NovyIntouchDevice onSettings invoked", {
      oldSettingsObj,
      newSettingsObj,
      changedKeysArr,
    });

    // Save in our own variable
    this._settings = newSettingsObj;

    // (Optional) Also call the parent method, which handles standard onSettings logic
    return await super.onSettings(
      oldSettingsObj,
      newSettingsObj,
      changedKeysArr
    );
  }

  /**
   * Override setSettings to store settings in our own variable,
   * then call the parent setSettings.
   */
  setSettings(settings) {
    this._settings = settings;
    // Return the promise so it can be awaited or caught
    return super
      .setSettings(settings)
      .then(() => {
        this.log("Settings updated successfully:", settings);
      })
      .catch((err) => {
        this.error("Error updating settings:", err);
      });
  }

  /**
   * Override getSettings to first return our cached _settings,
   * or if not found, fall back to the parent’s getSettings.
   */
  getSettings() {
    return this._settings || super.getSettings();
  }

  /**
   * If your driver handles raw payload requests (instead of
   * higher-level "command" objects), you must implement payloadToData().
   */
  static payloadToData(payload) {
    // Example logic
    if (payload.length === 12 || payload.length === 18) {
      const address = util.bitArrayToString(payload.slice(0, 10));
      if (address === Signal.address) {
        const unit = util.bitArrayToString(payload.slice(10, payload.length));
        const data = { address, unit };
        data.id = data.address + data.unit; // required for RFDriver
        return data;
      }
    }
    // If payload is invalid, return null
    return null;
  }

  /**
   * The reverse of payloadToData: given data, produce the raw bit array.
   */
  static dataToPayload(data) {
    if (data.address && data.unit) {
      return util.bitStringToBitArray(data.address + data.unit);
    }
    // Return null if invalid
    return null;
  }

  /**
   * Required if you're using rf.program, rf.codewheel or rf.dipswitch pairing.
   * Must return unique data object(s).
   */
  static generateData() {
    const data = {
      address: util.generateRandomBitString(10),
      unit: util.generateRandomBitString(8),
    };
    data.id = data.address + data.unit;
    return data;
  }

  /**
   * Allows you to decide how incoming data is matched to this specific device.
   * For example, checking addresses and units.
   */
  matchesData(deviceData) {
    // Use the parent's logic first, or if that fails,
    // check for matching the known Novy Intouch "Signal.address"
    return (
      super.matchesData(deviceData) ||
      (deviceData.address === Signal.address &&
        (deviceData.unit.length === 2 || deviceData.unit.length === 8))
    );
  }

  /**
   * Called when data is received from RF, but before it's handled.
   * Useful for additional transformations, logging, etc.
   */
  parseIncomingData(data) {
    data = super.parseIncomingData(data);
    data.id = data.address + data.unit;
    return data;
  }

  /**
   * Called when sending data out via RF, but before it's encoded.
   */
  parseOutgoingData(data) {
    data = super.parseOutgoingData(data);
    data.id = data.address + data.unit;
    return data;
  }
};
