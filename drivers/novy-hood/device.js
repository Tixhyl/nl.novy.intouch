"use strict";

const NovyIntouchDevice = require("../../lib/NovyIntouchDevice");
const Signal = require("../../lib/NovyIntouchSignal");

const TimeOuts = {
  runOut: 10 * 60 * 1000, // 10 minutes
  autoStop: 3 * 60 * 60 * 1000, // Safety stop after 3 hours (hood motor only)
  power: 6 * 60 * 1000, // 6 minutes (then reduce to speed 3)
};

module.exports = class NovyIntouchHoodDevice extends NovyIntouchDevice {
  /**
   * (Optional) In SDK v3 you can implement async onInit() if needed.
   * This is called once when the Device instance is created.
   */
  async onInit() {
    await super.onInit();
    this.log("NovyIntouchHoodDevice (SDK v3) has been initialized.");
  }

  /**
   * If you rely on generated data for pairing, override generateData().
   */
  static generateData() {
    const data = super.generateData();
    data.onoff = false;
    data.speed = 0;
    data.speed_level = "speed_0";
    data.light = false;
    data.command = "off";
    return data;
  }

  /**
   * We override getData() to fix mismatches in the device "id".
   */
  getData() {
    // HACK: Fix for unmatching IDs @ send dataCheck due to 'unit' change =>
    // should be handled by matchesData, but we do it here anyway.
    return this._data ? { ...this._data } : super.getData();
  }

  /**
   * Return the current "state" from device settings or fallback defaults.
   */
  getState(settings) {
    settings = settings || this.getSettings();
    const speedLevel = settings.speed_level || "speed_0";
    const speed = Number(speedLevel.substr(6));

    return {
      // Public
      speed,
      speed_level: speedLevel,
      light: Boolean(settings.light),

      // Internal
      offRunOut: settings.offRunOut,
      runOutActive: settings.runOutActive,
      targetSpeed: settings.targetSpeed,
      speedHistory: settings.speedHistory,
      lightHistory: settings.lightHistory,
    };
  }

  /**
   * Save a state object back into Device settings.
   */
  saveState(state) {
    const settings = {
      // Public
      speed: state.speed || 0,
      speed_level: "speed_" + (state.speed || 0),
      light: state.light,

      // Internal
      offRunOut: state.offRunOut,
      runOutActive: state.runOutActive,
      targetSpeed: state.targetSpeed,
      speedHistory: state.speedHistory,
      lightHistory: state.lightHistory,
    };

    this.setSettings(settings);
    return settings;
  }

  resetTimeout(timeout) {
    if (this._timeouts && this._timeouts[timeout]) {
      clearTimeout(this._timeouts[timeout]);
    }
  }

  activateTimeout(timeout, callback) {
    if (!this._timeouts) {
      this._timeouts = {};
    }
    if (callback) {
      this._timeouts[timeout] = setTimeout(() => callback(), timeout);
    }
  }

  /**
   * A helper to directly update our internal `_settings` and actual device settings.
   */
  updateState(settings) {
    this._settings = settings;
    this.setSettings(settings);
  }

  /**
   * Handle incoming RF data (e.g. user pressing a Novy remote).
   * We parse it, modify the state, then save and return the updated data.
   */
  parseIncomingData(data) {
    if (data) {
      const settings = this.getSettings();
      const state = this.getState(settings);

      switch (data.unit) {
        case Signal.onoff: {
          this.resetTimeout(TimeOuts.runOut);

          const onoff = state.speed > 0;
          data.command = state.runOutActive || onoff ? "off" : "on";

          state.speed = onoff
            ? state.runOutActive
              ? 0
              : state.speed
            : state.speedHistory || 1;

          state.targetSpeed = state.speed;
          state.light = onoff ? false : Boolean(settings.lightHistory);

          state.runOutActive = data.command === "off" && !state.runOutActive;

          if (state.runOutActive) {
            if (state.offRunOut === false) {
              // Re-send signal quickly to skip run-out mode
              setTimeout(() => {
                this.send({
                  address: Signal.address,
                  unit: Signal.onoff,
                  repeatingSignal: true,
                });
              }, 50);
            } else {
              // Activate a 10-minute run-out timer
              this.activateTimeout(TimeOuts.runOut, () => {
                this.updateState({
                  runOutActive: false,
                  speed: 0,
                  speed_level: "speed_0",
                });
              });
            }
          }
          delete state.offRunOut;
          break;
        }

        case Signal.light:
          state.light = !state.light;
          state.lightHistory = state.light;
          data.command = state.light ? "light_on" : "light_off";
          break;

        case Signal.increase:
          this.resetTimeout(TimeOuts.runOut);
          state.runOutActive = false;
          state.speed = Math.min(4, Math.max(0, Number(state.speed || 0) + 1));
          state.speedHistory = state.speed;
          data.command = "increase";
          this.handleTargetSpeed(state, data);
          break;

        case Signal.decrease:
          this.resetTimeout(TimeOuts.runOut);
          state.runOutActive = false;
          state.speed = Math.min(4, Math.max(0, Number(state.speed || 0) - 1));
          state.speedHistory = state.speed;
          data.command = "decrease";
          this.handleTargetSpeed(state, data);
          break;
      }

      // Update the rest of the state
      state.speed_level = "speed_" + state.speed;
      this.saveState(state);

      // Reflect these changes in `data`
      data.light = Boolean(state.light);
      data.speed = state.targetSpeed || state.speed;
      data.onoff = data.speed > 0;
      data.speed_level = "speed_" + data.speed;
    }

    return super.parseIncomingData(data);
  }

  /**
   * Helper for multi-step speed changes (e.g. going from speed=0 to speed=4).
   * We might re-send the 'increase' or 'decrease' signal multiple times.
   */
  handleTargetSpeed(state, data) {
    if (typeof state.targetSpeed !== "undefined") {
      if (state.speed < state.targetSpeed && data.unit === Signal.increase) {
        const msg = {
          address: Signal.address,
          unit: Signal.increase,
          repeatingSignal: true,
        };
        setTimeout(() => this.send(msg), 50);
      } else if (
        state.speed > state.targetSpeed &&
        data.unit === Signal.decrease
      ) {
        const msg = {
          address: Signal.address,
          unit: Signal.decrease,
          repeatingSignal: true,
        };
        setTimeout(() => this.send(msg), 50);
      } else {
        delete state.targetSpeed;
      }
    }
  }

  /**
   * Called when we are about to send data out via RF (e.g. from Flow actions).
   */
  assembleSendData(data) {
    if (data) {
      const settings = this.getSettings();
      const state = this.getState(settings);
      const onoff = state.speed > 0;

      // If it's a repeated signal (e.g., continuing to increase speed),
      // skip the big logic below, just pass it to super.
      if (data.repeatingSignal) {
        delete data.repeatingSignal;
        data = super.assembleSendData(data);

        // Reflect current state
        data.speed = state.speed;
        data.light = state.light;
      } else {
        // If no 'unit' specified, map capability changes to commands
        if (!data.unit) {
          if (data.onoff !== undefined) {
            switch (settings.onoff_action) {
              case "light":
                data.command = data.onoff ? "light_on" : "light_off";
                break;
              case "hood":
                data.command =
                  "speed_" + (data.onoff ? state.speedHistory || 1 : 0);
                break;
              case "device":
              default:
                data.command = data.onoff
                  ? "on"
                  : settings.run_out
                  ? "off_run_out"
                  : "off";
                break;
            }
          }
          if (data.speed !== undefined) {
            data.command = "speed_" + data.speed;
          }
          if (data.light !== undefined) {
            data.command = data.light ? "light_on" : "light_off";
          }
        }

        // Let the parent do any general processing
        data = super.assembleSendData(data);

        // Match each command to the correct 'unit'
        switch (data.command) {
          case "on":
            data.unit = !onoff ? Signal.onoff : Signal.none;
            data.speed = state.speedHistory || state.speed || 1;
            break;

          case "off":
          case "off_run_out":
            data.unit = onoff ? Signal.onoff : Signal.none;
            state.offRunOut = data.command === "off_run_out";
            data.speed = 0;
            break;

          case "toggle_onoff":
          case "toggle_onoff_run_out":
            data.unit = Signal.onoff;
            state.offRunOut = onoff && data.command === "toggle_onoff_run_out";
            data.speed = onoff ? 0 : state.speedHistory || state.speed || 1;
            break;

          case "light_on":
            data.unit = !state.light ? Signal.light : Signal.none;
            data.light = true;
            break;

          case "light_off":
            data.unit = state.light ? Signal.light : Signal.none;
            data.light = false;
            break;

          case "toggle_light":
            data.unit = Signal.light;
            data.light = !state.light;
            break;

          case "increase":
            data.unit = Signal.increase;
            delete state.targetSpeed;
            data.speed = Math.min(4, Math.max(0, Number(state.speed || 0) + 1));
            break;

          case "decrease":
            data.unit = Signal.decrease;
            delete state.targetSpeed;
            data.speed = Math.min(4, Math.max(0, Number(state.speed || 0) - 1));
            break;

          case "speed_0":
          case "speed_1":
          case "speed_2":
          case "speed_3":
          case "speed_4": {
            data.speed = Number(data.command.substr(6));
            if (data.speed === state.speed) {
              data.unit = Signal.none;
              delete state.targetSpeed;
            } else {
              // If we want to get from speed X to speed Y, we might set a target speed
              if (data.speed > state.speed) {
                state.targetSpeed = data.speed;
                data.unit = Signal.increase;
              } else if (data.speed < state.speed) {
                state.targetSpeed = data.speed;
                data.unit = Signal.decrease;
              }
            }
            break;
          }
        }

        // Save updated internal state
        this.saveState(state);
      }

      // Update data fields
      data.onoff = data.speed > 0;
      data.speed_level = "speed_" + data.speed;

      // Store the final data for future matching
      this._data = data;
    }

    return data;
  }
};
