'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VehicleMemory = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const prefKeys = ['tankwijzer:prefs', 'fuel-detour:prefs', 'border-fuel:prefs'];
  const carKey = 'tankwijzer:vehicle';
  const vehicleFields = ['consumption', 'consumptionOrigin', 'consUnit', 'litres', 'litresOrigin',
    'tank', 'tankOrigin', 'level', 'upliftEnabled', 'upliftPct'];
  function withoutVehicle(prefs) {
    const out = { ...prefs, vehicleForgotten: true };
    for (const key of vehicleFields) delete out[key];
    return out;
  }
  function hasCar(vehicle, origins) {
    return !!vehicle || Object.values(origins).includes('manual');
  }
  function create(getStorage, onError) {
    function read(key) {
      try { return JSON.parse(getStorage().getItem(key)); }
      catch { onError('read'); return null; }
    }
    function write(key, value) {
      try { getStorage().setItem(key, JSON.stringify(value)); return true; }
      catch { onError('save'); return false; }
    }
    function remove(key) {
      try { getStorage().removeItem(key); return true; }
      catch { onError('forget'); return false; }
    }
    function forget(prefs) {
      let ok = true;
      // Remove legacy copies too, so migrating preferences cannot restore the car.
      for (const key of [...prefKeys, carKey]) if (!remove(key)) ok = false;
      if (!write(prefKeys[0], withoutVehicle(prefs))) ok = false;
      if (!ok) onError('forget');
      return ok;
    }
    return { read, write, remove, forget };
  }
  return { prefKeys, carKey, withoutVehicle, hasCar, create };
}));
