import { DISTRICT_NAMES, type DistrictName } from "../constants/districts";

// The fixed list, so the app reads it from the server instead of keeping its
// own copy.
export function listDistricts(): readonly DistrictName[] {
  return DISTRICT_NAMES;
}
