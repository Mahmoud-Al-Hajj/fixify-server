-- Demo data for the presentation. Load into a freshly created database
-- (schema.sql, then this file):
--   mysql -u root fixify < scripts/seed-demo.sql
-- Every demo account's password is Demo1234!
-- Categories are looked up by name, so their auto-increment ids don't matter.

SET @pw = '$2b$12$wIw9zj40VI/ybF4/h6eDNupeMBvZClg4969GiPFG.jDB9C8wwsypy';

INSERT INTO users (id, full_name, email, phone, password_hash) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Rana Khoury',   'rana@demo.fixify',   '+961 3 100 001', @pw),
  ('00000000-0000-4000-8000-000000000002', 'Karim Haddad',  'karim@demo.fixify',  '+961 3 100 002', @pw),
  ('00000000-0000-4000-8000-000000000101', 'Elie Nassar',   'elie@demo.fixify',   '+961 3 200 101', @pw),
  ('00000000-0000-4000-8000-000000000102', 'Maya Saab',     'maya@demo.fixify',   '+961 3 200 102', @pw),
  ('00000000-0000-4000-8000-000000000103', 'Tony Aoun',     'tony@demo.fixify',   '+961 3 200 103', @pw),
  ('00000000-0000-4000-8000-000000000104', 'Hadi Mansour',  'hadi@demo.fixify',   '+961 3 200 104', @pw),
  ('00000000-0000-4000-8000-000000000105', 'Lara Fakhoury', 'lara@demo.fixify',   '+961 3 200 105', @pw),
  ('00000000-0000-4000-8000-000000000106', 'Sami Karam',    'sami@demo.fixify',   '+961 3 200 106', @pw);

INSERT INTO providers (id, bio, years_experience, area, is_accepting) VALUES
  ('00000000-0000-4000-8000-000000000101', 'Residential wiring, panels and fault finding.', 12, 'Hamra',     1),
  ('00000000-0000-4000-8000-000000000102', 'Electrical repairs and generator hookups.',      6, 'Achrafieh', 1),
  ('00000000-0000-4000-8000-000000000103', 'Leaks, water heaters and bathroom plumbing.',     15, 'Hamra',     1),
  ('00000000-0000-4000-8000-000000000104', 'Split AC servicing, gas top-ups and repairs.',     9, 'Jounieh',   1),
  ('00000000-0000-4000-8000-000000000105', 'Washing machines, fridges and ovens.',             7, 'Achrafieh', 1),
  ('00000000-0000-4000-8000-000000000106', 'Plumbing and small electrical jobs.',              4, 'Verdun',    0);

-- base_rate: the "from" price per trade. Maya leaves her Electrician rate
-- unset, so an Electrician search sorted by price shows "no rate -> last".
INSERT INTO provider_categories (provider_id, category_id, base_rate)
SELECT p.id, c.id, p.base_rate
FROM (
  SELECT '00000000-0000-4000-8000-000000000101' AS id, 'Electrician' AS name, 25.00 AS base_rate
  UNION ALL SELECT '00000000-0000-4000-8000-000000000102', 'Electrician', NULL
  UNION ALL SELECT '00000000-0000-4000-8000-000000000102', 'Generator & Solar', 45.00
  UNION ALL SELECT '00000000-0000-4000-8000-000000000103', 'Plumber', 35.00
  UNION ALL SELECT '00000000-0000-4000-8000-000000000104', 'AC & Refrigeration', 40.00
  UNION ALL SELECT '00000000-0000-4000-8000-000000000105', 'Appliance Repair', 30.00
  UNION ALL SELECT '00000000-0000-4000-8000-000000000106', 'Plumber', 30.00
  UNION ALL SELECT '00000000-0000-4000-8000-000000000106', 'Electrician', 20.00
) AS p
JOIN categories c ON c.name = p.name;

-- weekday: 0 = Sunday ... 6 = Saturday
INSERT INTO provider_availability (provider_id, weekday, start_time, end_time) VALUES
  ('00000000-0000-4000-8000-000000000101', 1, '08:00', '16:00'),
  ('00000000-0000-4000-8000-000000000101', 2, '08:00', '16:00'),
  ('00000000-0000-4000-8000-000000000101', 3, '08:00', '16:00'),
  ('00000000-0000-4000-8000-000000000101', 4, '08:00', '16:00'),
  ('00000000-0000-4000-8000-000000000101', 5, '08:00', '12:00'),
  ('00000000-0000-4000-8000-000000000102', 1, '10:00', '18:00'),
  ('00000000-0000-4000-8000-000000000102', 3, '10:00', '18:00'),
  ('00000000-0000-4000-8000-000000000102', 6, '09:00', '13:00'),
  ('00000000-0000-4000-8000-000000000103', 1, '07:30', '12:00'),
  ('00000000-0000-4000-8000-000000000103', 1, '13:00', '17:00'),
  ('00000000-0000-4000-8000-000000000103', 2, '07:30', '15:00'),
  ('00000000-0000-4000-8000-000000000103', 4, '07:30', '15:00'),
  ('00000000-0000-4000-8000-000000000104', 2, '09:00', '17:00'),
  ('00000000-0000-4000-8000-000000000104', 4, '09:00', '17:00'),
  ('00000000-0000-4000-8000-000000000104', 6, '09:00', '14:00'),
  ('00000000-0000-4000-8000-000000000105', 1, '09:00', '17:00'),
  ('00000000-0000-4000-8000-000000000105', 2, '09:00', '17:00'),
  ('00000000-0000-4000-8000-000000000105', 3, '09:00', '17:00'),
  ('00000000-0000-4000-8000-000000000106', 5, '10:00', '15:00');
