// Lebanon's 25 districts (qadaa) plus Beirut, which is not subdivided: the
// 26 of Wikipedia's "Districts of Lebanon", grouped by governorate, in common
// local English spelling. The only values providers.area and the search area
// filter accept; chk_providers_area (migration 007) holds the same list.
export const DISTRICT_NAMES = [
  // Beirut
  "Beirut",
  // Akkar
  "Akkar",
  // Baalbek-Hermel
  "Baalbek",
  "Hermel",
  // Beqaa
  "Rashaya",
  "West Bekaa",
  "Zahle",
  // Keserwan-Jbeil
  "Jbeil",
  "Keserwan",
  // Mount Lebanon
  "Aley",
  "Baabda",
  "Chouf",
  "Metn",
  // Nabatieh
  "Bint Jbeil",
  "Hasbaya",
  "Marjeyoun",
  "Nabatieh",
  // North
  "Batroun",
  "Bsharri",
  "Koura",
  "Minieh-Danniyeh",
  "Tripoli",
  "Zgharta",
  // South
  "Jezzine",
  "Sidon",
  "Tyre",
] as const;

export type DistrictName = (typeof DISTRICT_NAMES)[number];
