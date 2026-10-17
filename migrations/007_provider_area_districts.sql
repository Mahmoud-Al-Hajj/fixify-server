-- 007: providers.area holds one of Lebanon's 26 districts (DISTRICT_NAMES in
-- src/constants/districts.ts) or NULL. Existing free-text areas are mapped
-- first: the seed's Beirut neighbourhoods to Beirut, Jounieh to Keserwan;
-- anything else not in the list becomes NULL (that provider picks again).
-- To undo: ALTER TABLE providers DROP CONSTRAINT chk_providers_area;

UPDATE providers
SET area = CASE area
  WHEN 'Hamra' THEN 'Beirut'
  WHEN 'Achrafieh' THEN 'Beirut'
  WHEN 'Verdun' THEN 'Beirut'
  WHEN 'Jounieh' THEN 'Keserwan'
  ELSE area
END
WHERE area IN ('Hamra', 'Achrafieh', 'Verdun', 'Jounieh');

UPDATE providers SET area = NULL
WHERE area NOT IN (
  'Beirut', 'Akkar', 'Baalbek', 'Hermel', 'Rashaya', 'West Bekaa', 'Zahle',
  'Jbeil', 'Keserwan', 'Aley', 'Baabda', 'Chouf', 'Metn', 'Bint Jbeil',
  'Hasbaya', 'Marjeyoun', 'Nabatieh', 'Batroun', 'Bsharri', 'Koura',
  'Minieh-Danniyeh', 'Tripoli', 'Zgharta', 'Jezzine', 'Sidon', 'Tyre');

ALTER TABLE providers
  ADD CONSTRAINT chk_providers_area CHECK (area IS NULL OR area IN (
    'Beirut', 'Akkar', 'Baalbek', 'Hermel', 'Rashaya', 'West Bekaa', 'Zahle',
    'Jbeil', 'Keserwan', 'Aley', 'Baabda', 'Chouf', 'Metn', 'Bint Jbeil',
    'Hasbaya', 'Marjeyoun', 'Nabatieh', 'Batroun', 'Bsharri', 'Koura',
    'Minieh-Danniyeh', 'Tripoli', 'Zgharta', 'Jezzine', 'Sidon', 'Tyre'));
