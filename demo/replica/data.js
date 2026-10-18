/* RoadLedger TMS replica: deterministic seed data (in-memory only).
   The same seed always produces the same records. "Today" is fixed so dates, aging and date ranges are stable. */
(function () {
  'use strict';
  const RL = (window.RL = window.RL || {});

  // ---------- deterministic helpers ----------
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const rnd = mulberry32(20261016);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const chance = p => rnd() < p;
  const pad = (n, w) => String(n).padStart(w, '0');
  const r2 = n => Math.round(n * 100) / 100;

  const TODAY = new Date(2026, 9, 16, 9, 30, 0); // Fri Oct 16 2026, 09:30 local
  const DAY = 864e5;
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}T${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
  const dayOff = (days, h = 8, m = 0) => { const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + days, h, m); return iso(d); };
  RL.TODAY = TODAY; RL.iso = iso; RL.dayOff = dayOff;

  // ---------- geography ----------
  const CITIES = [
    ['Grand Prairie', 'TX', '75050', 32.75, -97.0], ['Jacksonville', 'FL', '32219', 30.33, -81.66], ['Houston', 'TX', '77032', 29.76, -95.37],
    ['Dallas', 'TX', '75241', 32.78, -96.8], ['Chino', 'CA', '91708', 34.01, -117.69], ['Hutchins', 'TX', '75141', 32.64, -96.71],
    ['Woodbridge', 'NJ', '07095', 40.56, -74.28], ['Laredo', 'TX', '78045', 27.53, -99.49], ['Canton', 'MS', '39046', 32.61, -90.04],
    ['Memphis', 'TN', '38118', 35.15, -90.05], ['Olive Branch', 'MS', '38654', 34.96, -89.83], ['Vernon', 'CA', '90058', 34.0, -118.21],
    ['Atlanta', 'GA', '30336', 33.75, -84.39], ['Chicago', 'IL', '60638', 41.88, -87.63], ['Indianapolis', 'IN', '46241', 39.77, -86.16],
    ['Columbus', 'OH', '43217', 39.96, -82.99], ['Kansas City', 'MO', '64120', 39.1, -94.58], ['Denver', 'CO', '80216', 39.74, -104.99],
    ['Phoenix', 'AZ', '85043', 33.45, -112.07], ['Salt Lake City', 'UT', '84104', 40.76, -111.89], ['Reno', 'NV', '89506', 39.53, -119.81],
    ['Portland', 'OR', '97230', 45.52, -122.68], ['Seattle', 'WA', '98108', 47.61, -122.33], ['Oklahoma City', 'OK', '73129', 35.47, -97.52],
    ['Nashville', 'TN', '37210', 36.16, -86.78], ['Charlotte', 'NC', '28214', 35.23, -80.84], ['Louisville', 'KY', '40218', 38.25, -85.76],
    ['St. Louis', 'MO', '63132', 38.63, -90.2], ['Minneapolis', 'MN', '55413', 44.98, -93.27], ['Detroit', 'MI', '48209', 42.33, -83.05],
    ['Harrisburg', 'PA', '17111', 40.27, -76.88], ['Allentown', 'PA', '18109', 40.6, -75.47], ['Savannah', 'GA', '31408', 32.08, -81.09],
    ['El Paso', 'TX', '79927', 31.76, -106.49], ['San Antonio', 'TX', '78219', 29.42, -98.49], ['Bessemer', 'AL', '35022', 33.4, -86.95],
    ['Joliet', 'IL', '60436', 41.53, -88.08], ['Fontana', 'CA', '92335', 34.09, -117.43], ['Stockton', 'CA', '95206', 37.96, -121.29],
    ['Edmond', 'OK', '73034', 35.65, -97.48],
  ].map(([city, state, zip, lat, lon], i) => ({ i, city, state, zip, lat, lon }));
  const STATE_NAMES = { TX: 'Texas', FL: 'Florida', CA: 'California', NJ: 'New Jersey', MS: 'Mississippi', TN: 'Tennessee', GA: 'Georgia', IL: 'Illinois', IN: 'Indiana', OH: 'Ohio', MO: 'Missouri', CO: 'Colorado', AZ: 'Arizona', UT: 'Utah', NV: 'Nevada', OR: 'Oregon', WA: 'Washington', OK: 'Oklahoma', NC: 'North Carolina', KY: 'Kentucky', MN: 'Minnesota', MI: 'Michigan', PA: 'Pennsylvania', AL: 'Alabama' };
  RL.CITIES = CITIES; RL.STATE_NAMES = STATE_NAMES;
  function hav(a, b) { const R = 3958.8, t = x => x * Math.PI / 180; const dLat = t(b.lat - a.lat), dLon = t(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
  /** Road miles between two cities for a mileage type (deterministic). */
  RL.roadMiles = (ci, cj, type) => { const a = CITIES[ci], b = CITIES[cj]; if (!a || !b) return 0; const base = Math.max(12, hav(a, b) * 1.17); const f = { 'Google map': 1, Trucking: 1.06, 'PC Miler': 1.03, 'PC Miler Practical': 1.04, Manual: 1 }[type] || 1; return r2(base * f); };
  RL.cityByName = s => { const q = String(s || '').toLowerCase(); return CITIES.find(c => q.includes(c.city.toLowerCase())) || null; };

  const STREETS = ['Roy Orr Blvd', 'Imeson Rd', 'Riverside Dr', 'E Cleveland Rd', 'Polk Ln', 'Downey Rd', 'Cedardale Dr', 'Nissan Pkwy', 'Commerce St', 'Industrial Pkwy', 'Distribution Way', 'Logistics Blvd', 'Airport Rd', 'Copper Rd', 'Perimeter Way', 'Grand Central Blvd', 'Sandshell Dr', 'Kimball Ave', 'Van Born Rd', 'Southfield Pkwy', 'Melltech Blvd', 'Expansion Blvd', 'Aldine Bender Rd', 'Homer Rd', 'Staeger Rd', 'Cornerway Blvd', 'Old Hickory Blvd', 'Trade Center Dr'];
  const FACILITIES = ['Prairie Electronics Corp.', 'JACFL Parcel Hub', 'LAX1 Retail DC', 'Ground Parcel Terminal', 'Lone Star Distribution', 'Sunbelt Cold Storage', 'Gulf Coast Plastics', 'Midwest Paper Mill', 'Riverside Foods DC', 'Summit Building Supply', 'Pioneer Steel Works', 'Harbor Terminal 4', 'Great Lakes Packaging', 'Desert Sun Produce', 'Cascade Lumber Yard', 'Blue Ridge Furniture', 'Evergreen Grocers DC', 'Atlas Auto Parts', 'Copper State Beverages', 'Magnolia Home Goods', 'Pacific Rim Imports', 'Heartland Grain Co-op', 'Ironclad Tools Warehouse', 'Northern Star Appliances', 'Peach State Poultry', 'Liberty Paper Products', 'Red River Cement', 'Bayou Chemicals', 'Silver Creek Dairy', 'Keystone Glass', 'Granite Peak Mattress', 'Mesa Solar Panels', 'Tidewater Seafood', 'Coastal Technologies', 'Universal International Services', 'Integrated Logistics DC'];
  const addr = () => `${ri(100, 9999)} ${pick(STREETS)}`;

  // ---------- company ----------
  const mcs = [
    { id: 1, name: 'Demo', company: 'RoadLedger Demo Transport LLC', number: '1180342', usdot: '3381920', phone: '(214) 555-0142', owner: 'Tutorial Account', notes: 'Main authority', address: '3450 Roy Orr Blvd, Grand Prairie, TX 75050', offices: [{ name: 'Head office', city: 'Grand Prairie, TX', phone: '(214) 555-0142' }, { name: 'Dispatch office', city: 'Houston, TX', phone: '(713) 555-0190' }] },
    { id: 2, name: 'Northline Freight', company: 'Northline Freight LLC', number: '1204418', usdot: '3420177', phone: '(312) 555-0181', owner: 'Gary Thompson', notes: 'Midwest lanes', address: '6000 Riverside Dr, Joliet, IL 60436', offices: [{ name: 'Joliet yard', city: 'Joliet, IL', phone: '(312) 555-0181' }] },
    { id: 3, name: 'Bluewater Carriers', company: 'Bluewater Carriers Inc', number: '1096531', usdot: '3195004', phone: '(904) 555-0117', owner: 'Gary Thompson', notes: 'Lease program', address: '4420 Imeson Rd, Jacksonville, FL 32219', offices: [] },
  ];
  // Older MC records in the settings list (pagination realism).
  const mcExtra = ['Kyogo Logistics', 'Luigi Logistics', 'Counter Arrow Logistics', 'Blue Ocean Logistics', 'National Logistics', 'American Popular Logistics', 'Unique Logistics', 'Linda Logistics', 'MC Logistics', 'Dream Team Freight', 'Red Ocean Logistics', 'Axe Logistics', 'Prairie Haul LLC', 'Coastline Express', 'Ridgeway Transport', 'Sunrise Carriers', 'Granite Haulers', 'Copper Trail Freight', 'Mile Marker Inc', 'Open Road Partners', 'Lakeshore Trucking', 'Highplains Cargo', 'Silverline Express', 'Westbound Freight'];
  mcExtra.forEach((n, k) => mcs.push({ id: 4 + k, name: n, company: n, number: String(1300000 + k * 7919), usdot: String(3500000 + k * 3571), phone: `(${ri(201, 989)}) 555-0${pad(ri(100, 199), 3)}`, owner: pick(['Jack Morgan', 'Ana Ruiz', 'Gary Thompson', 'Tutorial Account']), notes: pick(['-', 'Inactive authority', 'Partner MC', 'Old authority']), address: '', offices: [] }));

  const customers = [
    ['Sample Logistics', '135001', 'FACTORING COMPANY'], ['AMAZON LOGISTICS', '135797', 'FACTORING COMPANY'], ['Kestrel Logistics', '435146', 'FACTORING COMPANY'],
    ['California Freight Sales', '612203', 'DIRECT BILL'], ['Big State Logistics', '268241', 'FACTORING COMPANY'], ['Great Plains Transport Inc', '268240', 'QUICK PAY'],
    ['IL2000 Brokerage', '702115', 'DIRECT BILL'], ['Summer Logistics LLC', '581144', 'FACTORING COMPANY'], ['Benlin Freight Forwarding Inc', '435147', 'DIRECT BILL'],
    ['SkyTeam Freight', '804412', 'FACTORING COMPANY'], ['ZBAH Freight', '804413', 'DIRECT BILL'], ['10 Roads Logistics LLC', '921007', 'FACTORING COMPANY'],
    ['10-4 Logistics LLC', '921008', 'FACTORING COMPANY'], ['Redwood Lane Brokerage', '319552', 'QUICK PAY'], ['1-800-Pack Freight', '319553', 'DIRECT BILL'],
    ['Rochester Transportation', '556120', 'FACTORING COMPANY'], ['Gold Tree Trans', '556121', 'FACTORING COMPANY'], ['ZT Transportation', '556122', 'DIRECT BILL'],
    ['MS Express Inc', '556123', 'FACTORING COMPANY'], ['Lipton Lane Logistics', '556124', 'DIRECT BILL'], ['Zeromax Transportation', '556125', 'FACTORING COMPANY'],
    ['Copperline Brokerage', '660301', 'QUICK PAY'], ['Harbor Point Freight', '660302', 'FACTORING COMPANY'], ['Prairie Wind Logistics', '660303', 'DIRECT BILL'],
    ['Lone Star Haulage', '660304', 'FACTORING COMPANY'], ['Cascade Freight Partners', '660305', 'FACTORING COMPANY'], ['Riverbend Logistics', '660306', 'DIRECT BILL'],
    ['Northstar Brokerage', '660307', 'FACTORING COMPANY'], ['Atlas Ridge Logistics', '660308', 'QUICK PAY'], ['Keystone Cargo LLC', '660309', 'FACTORING COMPANY'],
  ].map(([name, mc, billing], k) => {
    const c = CITIES[(k * 7 + 3) % CITIES.length];
    return { id: k + 1, name, mc, billingType: billing, address: addr(), city: c.city, state: c.state, zip: c.zip,
      email: `billing@${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`, phone: `(${ri(201, 989)}) 555-0${pad(ri(100, 199), 3)}`,
      contact: pick(['Ben Jaminben', 'Lisa Park', 'Omar Hale', 'Rita Gomez', 'Tom Becker', 'Nina Shah', 'Carl Dunn']), terms: pick(['Net 30', 'Net 15', 'Quick pay 2%', 'Net 45']),
      creditLimit: pick([25000, 50000, 75000, 100000, 150000]), recent: k < 9, color: ['#9aa4b8', '#5ad1b3', '#7e3af2', '#5b8def', '#f2c94c', '#a0522d', '#e2574c', '#f2994a', '#27ae60', '#56ccf2'][k % 10] };
  });

  const carriers = ['Best Carrier Company', 'Swift Lane Carriers LLC', 'Pinecrest Freight Inc', 'Mesa Verde Haulers', 'Ironwood Transport', 'Evergreen Load Partners', 'Red Rock Carriers'].map((name, k) => ({ id: k + 1, name, mc: String(900100 + k * 37), phone: `(000) 123-45${pad(k, 2)}`, ready: k === 2 ? 'notready' : 'ready', insuranceExp: dayOff(30 + k * 40) }));

  const dispatchers = [
    { id: 1, first: 'Sam', last: 'Carter', email: 'sam.carter@roadledger-demo.example', phone: '(214) 555-0101', commission: 5, team: 'Team A', mcId: 1 },
    { id: 2, first: 'Lena', last: 'Ortiz', email: 'lena.ortiz@roadledger-demo.example', phone: '(214) 555-0102', commission: 3, team: 'Team A', mcId: 1 },
    { id: 3, first: 'Umid', last: 'Sultan', email: 'umid.sultan@roadledger-demo.example', phone: '(214) 555-0103', commission: 4, team: 'Team B', mcId: 2 },
    { id: 4, first: 'Kim', last: 'Johnson', email: 'kim.johnson@roadledger-demo.example', phone: '(214) 555-0104', commission: 5, team: 'Team B', mcId: 2 },
    { id: 5, first: 'Topias', last: 'Taavet', email: 'topias.taavet@roadledger-demo.example', phone: '(214) 555-0105', commission: 2.5, team: 'Team C', mcId: 3 },
  ];
  const users = [
    { id: 1, first: 'Tutorial', last: 'Account', email: 'tutorial@roadledger-demo.example', phone: '(214) 555-0100', role: 'Admin', status: 'ACTIVE', telegram: '@tutorial_acc', mcIds: [1, 2, 3], lastLogin: dayOff(0, 9, 12) },
    { id: 2, first: 'Gary', last: 'Thompson', email: 'gary.thompson@roadledger-demo.example', phone: '(214) 555-0110', role: 'Accountant', status: 'ACTIVE', telegram: '', mcIds: [1, 2], lastLogin: dayOff(-1, 16, 40) },
    { id: 3, first: 'Main', last: 'Dispatch', email: 'dispatch@roadledger-demo.example', phone: '(214) 555-0111', role: 'Dispatcher', status: 'ACTIVE', telegram: '@main_dispatch', mcIds: [1], lastLogin: dayOff(0, 7, 55) },
    { id: 4, first: 'Ana', last: 'Ruiz', email: 'ana.ruiz@roadledger-demo.example', phone: '(214) 555-0112', role: 'Safety manager', status: 'ACTIVE', telegram: '', mcIds: [1, 2, 3], lastLogin: dayOff(-3, 11, 5) },
    { id: 5, first: 'Peter', last: 'Lang', email: 'peter.lang@roadledger-demo.example', phone: '(214) 555-0113', role: 'Fleet manager', status: 'INVITED', telegram: '', mcIds: [2], lastLogin: '' },
    ...dispatchers.map((d, k) => ({ id: 6 + k, first: d.first, last: d.last, email: d.email, phone: d.phone, role: 'Dispatcher', status: 'ACTIVE', telegram: k % 2 ? '' : '@' + d.first.toLowerCase() + '_disp', mcIds: [d.mcId], lastLogin: dayOff(-k, 8, 30), dispatcherId: d.id })),
  ];

  // ---------- tariffs ----------
  const tariffs = [
    { id: 1, name: '0.8$ per mile', type: 'per_mile', loadedRate: 0.8, emptyRate: 0.8, percent: 0, appliesTo: 'Company driver' },
    { id: 2, name: '0.75$ per mile', type: 'per_mile', loadedRate: 0.75, emptyRate: 0.75, percent: 0, appliesTo: 'Company driver' },
    { id: 3, name: '0.7$ per mile', type: 'per_mile', loadedRate: 0.7, emptyRate: 0.7, percent: 0, appliesTo: 'Company driver' },
    { id: 4, name: '0.85$ loaded / 0.85$ empty', type: 'per_mile', loadedRate: 0.85, emptyRate: 0.85, percent: 0, appliesTo: 'Company driver' },
    { id: 5, name: '28% from gross', type: 'percent', loadedRate: 0, emptyRate: 0, percent: 28, appliesTo: 'Company driver' },
    { id: 6, name: '30% from gross', type: 'percent', loadedRate: 0, emptyRate: 0, percent: 30, appliesTo: 'Company driver' },
    { id: 7, name: '88% from gross', type: 'percent', loadedRate: 0, emptyRate: 0, percent: 88, appliesTo: 'Owner operator' },
    { id: 8, name: '90% from gross', type: 'percent', loadedRate: 0, emptyRate: 0, percent: 90, appliesTo: 'Owner operator' },
    { id: 9, name: '70% from gross (lease)', type: 'percent', loadedRate: 0, emptyRate: 0, percent: 70, appliesTo: 'Lease' },
  ];

  // ---------- fleet ----------
  const MAKES = [['Freightliner', 'Cascadia'], ['Peterbilt', '579'], ['Kenworth', 'T680'], ['Volvo', 'VNL 860'], ['International', 'LT625'], ['Freightliner', 'Cascadia 126'], ['Kenworth', 'T660'], ['Mack', 'Anthem']];
  const VINC = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  const vin = () => '1' + pick(['FU', 'XP', 'XK', 'V4', 'HS', 'M1']) + Array.from({ length: 14 }, () => pick(VINC.split(''))).join('');
  const plate = () => pick(['P', 'R', 'AW', 'JE', 'TX', 'B']) + ri(100000, 999999);
  const UNITS = ['007', '48729', '24659', '89312', '04352', '7007', '1707F', '12345', '2203', '2105', '2102', '1402', '1015', '718', '303', '207', '5501', '5502', '5503', '6110', '6111', '6112', '7720', '7721', '8040', '8041', '8042', '9100', '9101', '9102', '316', '317', '318', '420', '421', '422', '515', '516', '517', '618', '619', '620', '733', '734', '735', '850', '851', '852', '961', '962', '963', '1001', '1002', '1003', '1104', '1105', '1106', '1207', '1208', '1209'];
  const trucks = UNITS.map((unit, k) => {
    const [make, model] = MAKES[k % MAKES.length];
    return { id: k + 1, make, model, year: 2017 + (k % 8), unit, plate: plate(), vin: vin(), mcId: k < 40 ? 1 : k < 52 ? 2 : 3, ownerName: k % 9 === 4 ? 'Carrier Test LLC' : '', ownership: k % 9 === 4 ? 'Owner operator' : k % 11 === 6 ? 'Lease' : 'Company',
      odometer: ri(120000, 780000), status: 'AVAILABLE', tags: k % 13 === 2 ? ['Reefer unit'] : [], notes: k % 17 === 5 ? 'Check APU' : '', warnings: k % 15 === 3 ? ['Registration expires soon'] : [],
      active: k < 56, cityIdx: (k * 5 + 2) % CITIES.length, regExp: dayOff(20 + k * 9), inspExp: dayOff(60 + k * 7), eld: pick(['ELD-A', 'ELD-B']), fuelCard: '', daysInStatus: ri(1, 40) };
  });
  const TRL_TYPES = ["Dry van 53'", "Dry van 53'", "Reefer 53'", "Flatbed 48'", "Dry van 48'"];
  const trailers = Array.from({ length: 40 }, (_, k) => ({ id: k + 1, unit: 'TR-' + (2100 + k * 3), type: TRL_TYPES[k % TRL_TYPES.length], make: pick(['Wabash', 'Utility', 'Great Dane', 'Hyundai Translead', 'Stoughton']), year: 2015 + (k % 10), plate: plate(), vin: vin(), mcId: k < 30 ? 1 : 2, status: 'AVAILABLE', truckId: null, active: k < 38, ownership: k % 6 === 1 ? 'Lease' : 'Company', regExp: dayOff(40 + k * 11) }));

  // ---------- drivers ----------
  const FIRST = ['Joseph', 'Jessica', 'Daniel', 'Sarah', 'Michael', 'Sam', 'Samuel', 'Oliver', 'Lucas', 'Pavel', 'Joe', 'Juan', 'Mark', 'Maxim', 'Komil', 'Ali', 'Bill', 'Doni', 'Sami', 'Jimmy', 'Jorge', 'Jeffrey', 'James', 'Robert', 'Peter', 'David', 'William', 'Christopher', 'Anthony', 'Paul', 'Gabe', 'Larry', 'Patrick', 'Bob', 'Harry', 'Noah', 'Sardor', 'Shohruh', 'Edmund', 'Hasan', 'Victor', 'Ethan', 'Mason', 'Logan', 'Ryan'];
  const LAST = ['Chadrac', 'Evans', 'Harris', 'Robinson', 'Thompson', 'Nelson', 'Torres', 'Smith', 'Moura', 'Kalashnikov', 'Topini', 'Fernandez', 'Butler', 'Mishenko', 'Jalolov', 'Ali', 'Johnson', 'Doni', 'Sami', 'Green', 'Collins', 'Davis', 'Smith', 'Williams', 'Pen', 'Jones', 'Miller', 'Anderson', 'Smith', 'Gonza', 'Newell', 'Johnson', 'Johnson', 'Bale', 'Johnson', 'Parker', 'Rahman', 'Rahmanov', 'Driver', 'Tursun', 'Kovac', 'Reed', 'Brooks', 'Hayes', 'Price'];
  const DTYPES = ['Company driver', 'Company driver', 'Owner operator', 'Company driver', 'Company driver', 'Lease', 'Company driver', 'Owner operator'];
  const drivers = FIRST.map((first, k) => {
    const type = k < 5 ? ['Company driver', 'Company driver', 'Owner operator', 'Company driver', 'Company driver'][k] : DTYPES[k % DTYPES.length];
    const tariffId = k === 0 ? 1 : k === 1 ? 5 : k === 2 ? 8 : k === 3 || k === 4 ? 3 : type === 'Owner operator' ? pick([7, 8]) : type === 'Lease' ? 9 : pick([1, 2, 3, 4, 5, 6]);
    const last = LAST[k];
    return { id: k + 1, first, last, type, mcId: k < 32 ? 1 : k < 40 ? 2 : 3, phone: `(${ri(201, 989)}) 555-${pad(ri(1000, 9999), 4)}`, email: k < 5 ? '' : `${first.toLowerCase()}.${last.toLowerCase()}${k}@mail.example`,
      status: 'available', truckId: null, trailerId: null, team: false, coDriverId: null, tariffId, employment: 'ACTIVE', ready: 'ready', tags: k === 10 ? ['B class'] : [], warnings: [],
      hireDate: dayOff(-ri(60, 1400)), cdl: 'CDL' + ri(1000000, 9999999), cdlState: pick(['TX', 'IL', 'FL', 'OH', 'GA']), cdlExp: dayOff(ri(-5, 900)), medExp: dayOff(ri(-10, 600)), dob: `19${ri(65, 99)}-${pad(ri(1, 12), 2)}-${pad(ri(1, 28), 2)}`,
      address: `${addr()}, ${CITIES[(k * 3) % CITIES.length].city}, ${CITIES[(k * 3) % CITIES.length].state}`, dispatcherId: (k % 5) + 1, cityIdx: (k * 3 + 1) % CITIES.length, updateNote: '', terminatedAt: '', termReason: '',
      docs: [{ type: 'CDL', name: `cdl-${first.toLowerCase()}.pdf`, exp: '' }, { type: 'Medical card', name: `medical-${first.toLowerCase()}.pdf`, exp: '' }].filter((_, j) => k % 4 !== 3 || j === 0), payTo: k % 3 === 0 ? 'Limited Corporation' : `${first} ${last}`, telegram: k % 4 === 0 ? `@${first.toLowerCase()}${k}` : '', app: k % 3 !== 2 };
  });
  drivers.forEach(d => { d.docs.forEach(doc => { doc.exp = doc.type === 'CDL' ? d.cdlExp : d.medExp; }); });
  // Terminated and not-ready drivers.
  [41, 42, 43].forEach(id => { const d = drivers[id - 1]; d.employment = 'TERMINATED'; d.status = 'inactive'; d.terminatedAt = dayOff(-ri(20, 200)); d.termReason = pick(['Resigned', 'Contract ended', 'Moved to another carrier']); });
  [13, 16, 18, 19, 21, 27, 34].forEach(id => { drivers[id - 1].ready = 'notready'; drivers[id - 1].warnings = [pick(['Medical card expired', 'Missing MVR', 'Drug test pending', 'CDL expires soon'])]; });
  drivers[23].ready = 'blocked'; drivers[23].warnings = ['Blocked: failed drug test'];
  // Truck and trailer assignment: drivers 1..36 (not terminated) get trucks.
  const activeDrivers = drivers.filter(d => d.employment === 'ACTIVE');
  activeDrivers.slice(0, 38).forEach((d, k) => {
    const t = trucks[k]; d.truckId = t.id; t.driverId = d.id; t.cityIdx = d.cityIdx;
    if (k < 30) { const tr = trailers[k]; d.trailerId = tr.id; tr.truckId = t.id; }
  });
  // A few team drivers.
  [[6, 7], [12, 14], [26, 28]].forEach(([a, b]) => { drivers[a - 1].team = true; drivers[a - 1].coDriverId = b; drivers[b - 1].team = true; drivers[b - 1].coDriverId = a; });
  trucks.forEach(t => { if (!t.driverId) t.driverId = null; });

  // ---------- loads ----------
  const ORDER = ['offer', 'booked', 'assigned', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid'];
  const EQUIP = ['Dry van', 'Dry van', 'Dry van', 'Reefer', 'Flatbed', 'Dry van', 'Power only'];
  const COMMOD = ['FAK', 'Paper products', 'Frozen poultry', 'Steel coils', 'Electronics', 'Beverages', 'Furniture', 'Auto parts', 'Building materials', 'Produce', 'Plastic resin', 'Retail goods'];
  const loads = [];
  let tripSeq = 0;
  const tariffById = id => tariffs.find(t => t.id === id);
  RL.calcPay = (driver, loadPay, loaded, empty) => {
    const t = driver && tariffById(driver.tariffId); if (!t) return 0;
    if (t.type === 'percent') return r2(loadPay * t.percent / 100);
    if (t.type === 'flat') return r2(t.flat || 0);
    return r2(loaded * t.loadedRate + empty * t.emptyRate);
  };
  function mkLoad(o) {
    const id = o.id;
    const from = CITIES[o.from], to = CITIES[o.to];
    const loaded = RL.roadMiles(o.from, o.to, 'Google map');
    const empty = o.empty != null ? o.empty : r2(ri(0, 120) + rnd());
    const loadPay = o.loadPay || Math.round(loaded * (1.9 + rnd() * 1.6) / 50) * 50 + 100;
    const pu = o.pu, del = o.del;
    const stops = [
      { id: 1, type: 'Pickup', company: o.puCo || pick(FACILITIES), address: addr(), cityIdx: from.i, city: from.city, state: from.state, zip: from.zip, from: pu, to: o.puTo || bump(pu, 8) },
      { id: 2, type: 'Delivery', company: o.delCo || pick(FACILITIES), address: addr(), cityIdx: to.i, city: to.city, state: to.state, zip: to.zip, from: del, to: o.delTo || bump(del, 5) },
    ];
    const cust = customers[(o.customerId || 1) - 1];
    const L = {
      id, sid: 'DT-' + pad(id, 6), loadId: o.loadId || String(ri(1000000, 99999999)), refId: o.refId || (chance(0.4) ? String(ri(20000000, 29999999)) : ''), customerId: cust.id, mcId: o.mcId || 1,
      mode: o.mode || 'FTL', equipment: o.equipment || pick(EQUIP), equipments: ['Van 48', 'Van 53', 'Reefer 53', 'Flatbed 48'].slice(0, ri(1, 3)), addEquip: chance(0.2) ? ['Load bars'] : [], driverReq: chance(0.1) ? ['TWIC'] : [],
      status: o.status, stops, loadPay, otherPay: o.otherPay || [], tonu: false, tonuAmount: 0, paymentType: cust.billingType === 'QUICK PAY' ? 'Quick pay' : 'Standard',
      mileageType: 'Google map', miles: { total: r2(loaded + empty), loaded, empty }, tags: o.tags || (chance(0.55) ? ['AUTOBOT'] : []), createdBy: o.createdBy || pick(['Tutorial Account', 'Gary Thompson', 'Main Dispatch', 'Sam Carter']),
      createdAt: o.createdAt || bump(pu, -24 * ri(1, 5)), special: o.special || (chance(0.2) ? pick(['Driver must call 1 hour before arrival.', 'Seal must remain intact.', 'Keep reefer at 34°F continuous.', 'No touch freight.']) : ''),
      commodities: [{ desc: o.commodity || pick(COMMOD), qty: ri(10, 26), type: 'Pallets', pcs: ri(10, 1200), wt: ri(18000, 44000), w: 48, h: 60, l: 40, note: '' }], freightTags: { temperature: false, hazmat: false, oversize: false, highValue: false, team: false },
      trips: [], invoice: { createdAt: '', batchId: null, status: 'PENDING', billingType: cust.billingType, sent: false, factored: false, scheduleId: null, paidAt: '' }, dispatcherId: o.dispatcherId || ri(1, 5), commission: '',
      eta: { at: '', miles: '' }, deliveredAt: '', pickedAt: '', events: [], notes: [], chat: [], docs: [{ id: 1, type: 'Rate confirmation', name: `rate-confirmation-${id}.pdf`, at: bump(pu, -30), by: 'AI parse' }],
      following: true, locked: false, amazon: !!o.amazon, deleted: false,
    };
    if (L.equipment === 'Reefer') L.freightTags.temperature = true;
    L.events.push({ at: L.createdAt, text: `${L.createdBy} created Load` });
    return L;
  }
  function bump(isoStr, hours) { const d = new Date(isoStr); d.setTime(d.getTime() + hours * 36e5); return iso(d); }
  RL.bumpIso = bump;
  function addTrip(L, driver, opts = {}) {
    tripSeq++;
    const n = L.trips.length + 1;
    const truck = driver.truckId ? trucks[driver.truckId - 1] : null;
    const loaded = L.miles.loaded, empty = L.miles.empty;
    const tr = { id: `TR-${pad(L.id, 6)}-${pad(n, 2)}`, status: opts.status || 'Assigned', driverId: driver.id, carrierId: null, truckId: truck ? truck.id : null, trailerId: driver.trailerId, coDriverId: driver.coDriverId,
      from: 0, to: L.stops.length - 1, relay: null, driverPay: opts.pay != null ? opts.pay : RL.calcPay(driver, L.loadPay, loaded, empty), confirmed: true, loadedMiles: loaded, emptyMiles: empty, emptyManual: false, salaryBatchId: null, settlementId: null, split: !!opts.split, note: '' };
    L.trips.push(tr);
    return tr;
  }
  const STATUS_TEXT = { offer: 'Offer', booked: 'Booked', assigned: 'Assigned', dispatched: 'Dispatched', in_transit: 'In-Transit', delivered: 'Delivered', invoiced: 'Invoiced', paid: 'Paid' };
  function progress(L, status, driver, user) {
    // Walk the load through its lifecycle up to `status`, writing events like the real app.
    const who = user || L.createdBy;
    const idx = ORDER.indexOf(status);
    L.status = status;
    if (idx >= ORDER.indexOf('assigned') && driver) {
      const tr = addTrip(L, driver);
      L.events.push({ at: bump(L.createdAt, 2), text: `${who} assigned ${driver.first} ${driver.last} to trip ${tr.id}` });
    }
    if (idx >= ORDER.indexOf('dispatched')) L.events.push({ at: bump(L.createdAt, 3), text: `${who} updated Load to dispatched status` });
    if (idx >= ORDER.indexOf('in_transit')) { L.pickedAt = L.stops[0].from; L.trips.forEach(t => (t.status = 'In-transit')); L.events.push({ at: L.stops[0].from, text: `${who} updated Load to in-transit status` }); }
    if (idx >= ORDER.indexOf('delivered')) {
      L.deliveredAt = L.stops[L.stops.length - 1].from; L.trips.forEach(t => (t.status = 'Delivered'));
      L.docs.push({ id: 2, type: 'Proof of Delivery', name: `pod-${L.sid}.jpg`, at: bump(L.deliveredAt, 1), by: driver ? `${driver.first} ${driver.last}` : 'Driver app' });
      L.events.push({ at: bump(L.deliveredAt, 1), text: `Proof of Delivery for Load ${L.sid}` });
      L.events.push({ at: L.deliveredAt, text: `${who} updated Load to delivered status` });
      L.stopsOnTime = chance(0.85);
    }
    if (idx >= ORDER.indexOf('invoiced')) { L.invoice.createdAt = bump(L.deliveredAt, 20); L.events.push({ at: L.invoice.createdAt, text: `${who} created invoice` }); }
    if (idx >= ORDER.indexOf('paid')) { L.invoice.paidAt = bump(L.deliveredAt, 24 * ri(10, 30)); }
  }

  // Tutorial loads 1..12 (the ones seen in the videos), then the history 13..150.
  const busy = new Set();
  const driverFor = (idx) => { const pool = activeDrivers.filter(d => d.truckId && d.ready !== 'blocked'); return pool[idx % pool.length]; };
  [5, 3, 9].forEach(id => busy.add(id)); // drivers on the tutorial loads 7, 8 and 9
  const freeDriver = () => { const d = activeDrivers.find(x => x.truckId && x.ready === 'ready' && !busy.has(x.id) && ![15, 22, 30, 25, 33, 17, 35, 36].includes(x.id)); if (d) busy.add(d.id); return d || null; };
  const T = [
    { id: 1, from: 12, to: 13, customerId: 3, pu: dayOff(-40), del: dayOff(-38), status: 'paid', drv: 6 },
    { id: 2, from: 4, to: 3, customerId: 1, pu: dayOff(-33), del: dayOff(-30), status: 'paid', drv: 7 },
    { id: 3, from: 6, to: 5, customerId: 3, pu: dayOff(-25), del: dayOff(-24), status: 'invoiced', drv: 8 },
    { id: 4, from: 0, to: 1, customerId: 1, loadId: '15128819', refId: '20101992', loadPay: 4200, pu: dayOff(2, 8), puTo: dayOff(2, 16), del: dayOff(4, 8), delTo: dayOff(4, 13), status: 'booked', puCo: 'Prairie Electronics Corp.', delCo: 'JACFL Parcel Hub', commodity: 'FAK', equipment: 'Dry van', createdBy: 'Tutorial Account', tags: ['AUTOBOT'] },
    { id: 5, from: 6, to: 5, customerId: 3, loadId: '00000111', loadPay: 5500, pu: dayOff(3, 9), del: dayOff(5, 9), status: 'booked', puCo: 'Ground Parcel Terminal', delCo: 'Ground Parcel Terminal', createdBy: 'Tutorial Account', tags: ['AUTOBOT'] },
    { id: 6, from: 4, to: 3, customerId: 1, loadId: '1122334455', loadPay: 5600, pu: dayOff(1, 8), del: dayOff(3, 10), status: 'booked', puCo: 'LAX1 Retail DC', delCo: 'Ground Parcel Terminal', createdBy: 'Super Admin', tags: ['AUTOBOT'] },
    { id: 7, from: 7, to: 8, customerId: 11, loadId: 'JL-223188', loadPay: 2200, pu: dayOff(0, 6), del: dayOff(1, 14), status: 'dispatched', drv: 5, puCo: 'Universal International Services', delCo: 'Integrated Logistics DC' },
    { id: 8, from: 2, to: 0, customerId: 2, loadId: '116KT9NVV', loadPay: 300, pu: dayOff(0, 10), del: dayOff(0, 18), status: 'dispatched', drv: 5, split: 3, mcId: 1, amazon: true, puCo: 'Amazon HOU8', delCo: 'Amazon DFW6', empty: 52.49 },
    { id: 9, from: 9, to: 14, customerId: 12, loadId: '004637038', loadPay: 2100, pu: dayOff(-1, 7), del: dayOff(0, 15), status: 'in_transit', drv: 9 },
    { id: 10, from: 32, to: 25, customerId: 16, loadId: '2931598', loadPay: 600, pu: dayOff(-6, 8), del: dayOff(-5, 9), status: 'delivered', drv: 11 },
    { id: 11, from: 10, to: 11, customerId: 21, loadId: '8X71180', loadPay: 4953.8, pu: dayOff(-5, 8), del: dayOff(-3, 9), status: 'delivered', drv: 11 },
    { id: 12, from: 2, to: 0, customerId: 2, loadId: '116KT9N12', loadPay: 350, pu: dayOff(-4, 9), del: dayOff(-4, 17), status: 'delivered', drv: 4, amazon: true, puCo: 'Amazon HOU8', delCo: 'Amazon DFW6' },
  ];
  T.forEach(o => {
    const L = mkLoad(o);
    if (o.id === 8) { L.miles = { total: 305.47, loaded: 252.98, empty: 52.49 }; }
    loads.push(L);
    const drv = o.drv ? drivers[o.drv - 1] : null;
    progress(L, o.status, drv, o.id === 8 ? 'Tutorial Account' : undefined);
    if (o.split && drv) {
      // DT-000008: trip split between two drivers (Michael Thompson and Daniel Harris), as in the tutorial.
      const t1 = L.trips[0]; t1.driverPay = 180; t1.to = 1; t1.relay = { company: 'Relay yard', city: 'Grand Prairie', state: 'TX', cityIdx: 0 };
      const d2 = drivers[o.split - 1];
      const t2 = addTrip(L, d2, { split: true, pay: 95 }); t2.from = 0; t2.relayFrom = true;
      L.events.push({ at: bump(L.createdAt, 4), text: 'Tutorial Account Re-calculated trip TR-000008-01' });
      L.events.push({ at: bump(L.createdAt, 4.1), text: "Tutorial Account updated Driver Pay for Load's trip: $82.58 → $180.00" });
      L.events.push({ at: bump(L.createdAt, 4.2), text: 'Tutorial Account Re-calculated trip TR-000008-01' });
    }
  });
  loads[5].chat = []; // DT-000006 is used for the duplicate-ID example
  // History: 13..150, oldest first.
  for (let id = 13; id <= 150; id++) {
    const k = id - 13; // 0..137
    const puDays = -112 + Math.floor(k * 0.83) + (k > 128 ? 4 : 0);
    const from = (k * 7 + 3) % CITIES.length; let to = (k * 11 + 9) % CITIES.length; if (to === from) to = (to + 5) % CITIES.length;
    const loaded = RL.roadMiles(from, to);
    const transitDays = Math.max(1, Math.round(loaded / 520));
    const pu = dayOff(puDays, 6 + (k % 9)), del = dayOff(puDays + transitDays, 7 + (k % 8));
    let status;
    if (puDays > 0) status = k % 7 === 0 ? 'offer' : k % 5 === 0 ? 'assigned' : 'booked';
    else if (puDays >= -1) status = k % 2 ? 'dispatched' : 'in_transit';
    else if (puDays + transitDays > 0) status = 'in_transit';
    else if (puDays >= -10) status = 'delivered';
    else if (puDays >= -34) status = k % 6 === 0 ? 'delivered' : 'invoiced';
    else status = 'paid';
    const customerId = 1 + ((k * 13) % customers.length);
    const L = mkLoad({ id, from, to, customerId, pu, del, status, mcId: k % 10 === 7 ? 2 : 1, amazon: customerId === 2 });
    loads.push(L);
    const active = ['assigned', 'dispatched', 'in_transit'].includes(status);
    const drv = status === 'offer' || status === 'booked' ? null : active ? freeDriver() : driverFor(k * 3 + 1);
    progress(L, status, drv);
    if (status !== 'offer' && status !== 'booked' && !drv) L.status = 'booked';
  }
  // Current week: loads on the road and booked for the next days (151..172), each active one with its own driver.
  const CUR = ['in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'dispatched', 'dispatched', 'dispatched', 'dispatched', 'dispatched', 'assigned', 'assigned', 'assigned',
    'booked', 'booked', 'booked', 'booked', 'booked', 'offer', 'booked', 'booked'];
  CUR.forEach((status, j) => {
    const id = 151 + j;
    const from = (j * 9 + 5) % CITIES.length; let to = (j * 5 + 17) % CITIES.length; if (to === from) to = (to + 3) % CITIES.length;
    const puDays = status === 'in_transit' ? -1 - (j % 2) : status === 'dispatched' ? (j % 2) : status === 'assigned' ? 1 + (j % 2) : 1 + (j % 6);
    const transit = Math.max(1, Math.round(RL.roadMiles(from, to) / 520));
    const L = mkLoad({ id, from, to, customerId: 1 + ((j * 7) % customers.length), pu: dayOff(puDays, 6 + (j % 8)), del: dayOff(puDays + transit, 8 + (j % 6)), status, mcId: j % 6 === 5 ? 2 : 1, amazon: j % 7 === 3 });
    if (L.amazon) L.customerId = 2;
    loads.push(L);
    progress(L, status, ['assigned', 'dispatched', 'in_transit'].includes(status) ? freeDriver() : null);
  });
  // Other pay examples (detention, lumper) on a few loads.
  [20, 33, 47, 61, 88, 102, 118].forEach((id, j) => { const L = loads[id - 1]; L.otherPay.push(j % 2 ? { charge: 'Lumper', type: 'Customer', amount: 150 + j * 25, note: 'Lumper receipt attached' } : { charge: 'Detention', type: 'Customer', amount: 75 * (j + 1), note: `${j + 2} hours at receiver` }); });
  // Missing POD on one load in batch IB-000149 (frame vimeo876389787-t275) and on a few delivered loads.
  // Current driver and truck status derived from active loads.
  loads.forEach(L => {
    if (['assigned', 'dispatched', 'in_transit'].includes(L.status)) L.trips.forEach(t => {
      const d = drivers[t.driverId - 1]; if (!d) return;
      d.status = L.status === 'in_transit' ? 'in_transit' : 'dispatched'; d.currentLoadId = L.id;
      if (t.truckId) trucks[t.truckId - 1].status = L.status === 'in_transit' ? 'IN TRANSIT' : 'DISPATCHED';
      if (d.trailerId) trailers[d.trailerId - 1].status = 'IN USE';
    });
  });
  // Some drivers home, at the shop, resting, inactive.
  [15, 22, 30].forEach(id => { const d = drivers[id - 1]; if (d.status === 'available') { d.status = 'home'; if (d.truckId) trucks[d.truckId - 1].status = 'HOME'; } });
  [25, 33].forEach(id => { const d = drivers[id - 1]; if (d.status === 'available') { d.status = 'shop'; if (d.truckId) trucks[d.truckId - 1].status = 'SHOP'; } });
  [17].forEach(id => { const d = drivers[id - 1]; if (d.status === 'available') d.status = 'rest'; });
  [35, 36].forEach(id => { const d = drivers[id - 1]; if (d.status === 'available') d.status = 'inactive'; });
  trucks.forEach((t, k) => { if (!t.driverId && t.status === 'AVAILABLE') t.status = k % 7 === 3 ? 'SHOP' : k % 5 === 1 ? 'YARD' : 'AVAILABLE'; if (!t.active) t.status = 'INACTIVE'; });
  trailers.forEach(tr => { if (!tr.active) tr.status = 'INACTIVE'; else if (tr.status !== 'IN USE' && tr.id % 9 === 4) tr.status = 'SHOP'; });

  // ---------- invoice batches ----------
  const invBatches = [];
  const billed = loads.filter(L => (L.status === 'invoiced' || L.status === 'paid') && L.id > 12).sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt));
  let bid = 131;
  for (let i = 0; i < billed.length;) {
    const n = 2 + (i % 5); const group = billed.slice(i, i + n); i += n;
    if (bid === 149) bid++;
    const created = bump(group[group.length - 1].deliveredAt, 30);
    const paid = group.every(L => L.status === 'paid');
    const b = { id: bid++, status: paid ? 'PAID' : 'POSTED', createdBy: pick(['Super Admin', 'Gary Thompson', 'Main Dispatch', 'Tutorial Account']), createdAt: created, mcId: group[0].mcId, loadIds: group.map(L => L.id), notes: '', sentIds: group.map(L => L.id), events: [{ at: created, text: 'Batch created' }, { at: bump(created, 2), text: 'Batch sent' }] };
    group.forEach(L => { L.invoice.batchId = b.id; L.invoice.status = b.status; L.invoice.sent = true; if (!L.invoice.createdAt) L.invoice.createdAt = created; });
    invBatches.push(b);
  }
  // IB-000149: unposted, six delivered loads, one without a Proof of Delivery.
  const forIb149 = loads.filter(L => L.status === 'delivered' && L.id > 12 && !L.invoice.batchId).slice(0, 6);
  if (forIb149.length) {
    const created = dayOff(-2, 9, 22);
    invBatches.push({ id: 149, status: 'UNPOSTED', createdBy: 'Gary Thompson', createdAt: created, mcId: 1, loadIds: forIb149.map(L => L.id), notes: '', sentIds: [], events: [{ at: created, text: 'Batch created' }] });
    forIb149.forEach(L => { L.invoice.batchId = 149; L.invoice.status = 'UNPOSTED'; L.invoice.createdAt = created; });
    const noPod = forIb149[0]; noPod.docs = noPod.docs.filter(d => d.type !== 'Proof of Delivery');
  }
  invBatches.sort((a, b) => b.id - a.id);
  // A delivered load in the flow example without POD (not batched).
  // Factoring: some posted batches' invoices were sent to factoring.
  const factoringCos = [
    { id: 1, name: 'Triumph Lane Factoring', email: 'schedules@triumphlane.example', phone: '(800) 555-0144', fee: 2.5, address: 'PO Box 610028, Dallas, TX 75261', remit: 'NOTICE OF ASSIGNMENT: This account has been assigned and must be paid only to Triumph Lane Factoring, PO Box 610028, Dallas, TX 75261.', default: true },
    { id: 2, name: 'Apex Rate Capital', email: 'funding@apexrate.example', phone: '(800) 555-0177', fee: 3, address: '1200 Main St Suite 900, Kansas City, MO 64105', remit: 'Please remit payment to Apex Rate Capital, 1200 Main St Suite 900, Kansas City, MO 64105.', default: false },
    { id: 3, name: 'Open Road Funding', email: 'ops@openroadfunding.example', phone: '(800) 555-0109', fee: 1.9, address: '45 Commerce Way, Atlanta, GA 30336', remit: 'Remit to Open Road Funding, 45 Commerce Way, Atlanta, GA 30336. Payments to any other party will not release the debtor.', default: false },
  ];
  const factoringSchedules = [];
  let sch = 4410;
  invBatches.filter(b => b.status === 'PAID').slice(0, 6).forEach(b => {
    const ids = b.loadIds.filter(id => loads[id - 1].invoice.billingType === 'FACTORING COMPANY');
    if (!ids.length) return;
    factoringSchedules.push({ id: sch, companyId: 1, loadIds: ids, sentAt: bump(b.createdAt, 3), status: 'FUNDED', amount: ids.reduce((s, id) => s + loads[id - 1].loadPay, 0), docs: ['Invoice', 'Rate confirmation', 'Proof of Delivery'] });
    ids.forEach(id => { loads[id - 1].invoice.factored = true; loads[id - 1].invoice.scheduleId = sch; });
    sch++;
  });

  // ---------- salary batches ----------
  const deductionTypes = [
    { id: 1, code: 'bobtail_insurance', name: 'Bobtail insurance', description: 'Bobtail', default: 200 },
    { id: 2, code: 'ifta', name: 'IFTA', description: 'IFTA', default: 35 },
    { id: 3, code: 'loan', name: 'Loan', description: 'Scheduled personal loan payment', default: 500 },
    { id: 4, code: 'occupational_accident', name: 'Occupational accident', description: 'OccAcc insurance', default: 45 },
    { id: 5, code: 'eld', name: 'ELD', description: 'ELD subscription', default: 25 },
    { id: 6, code: 'trailer_rent', name: 'Trailer rent', description: 'Trailer rental', default: 150 },
    { id: 7, code: 'fuel', name: 'Fuel', description: 'Fuel card transactions', default: 0 },
    { id: 8, code: 'toll', name: 'Toll', description: 'Toll transactions', default: 0 },
    { id: 9, code: 'escrow', name: 'Escrow', description: 'Escrow deposit', default: 100 },
  ];
  const schedDeductions = [
    { id: 1, driverId: 11, typeId: 1, description: 'Bobtail', frequency: 'Weekly', day: 'Friday', amount: 200, startDate: dayOff(-120), endDate: '', limit: 0, status: 'ACTIVE' },
    { id: 2, driverId: 11, typeId: 2, description: 'IFTA', frequency: 'Weekly', day: 'Friday', amount: 35, startDate: dayOff(-120), endDate: '', limit: 0, status: 'ACTIVE' },
    { id: 3, driverId: 11, typeId: 3, description: 'Scheduled personal loan payment', frequency: 'Monthly', day: '1', amount: 500, startDate: dayOff(-90), endDate: '', limit: 3000, status: 'ACTIVE' },
    { id: 4, driverId: 3, typeId: 4, description: 'OccAcc insurance', frequency: 'Weekly', day: 'Friday', amount: 45, startDate: dayOff(-200), endDate: '', limit: 0, status: 'ACTIVE' },
    { id: 5, driverId: 3, typeId: 5, description: 'ELD subscription', frequency: 'Monthly', day: '15', amount: 25, startDate: dayOff(-200), endDate: '', limit: 0, status: 'ACTIVE' },
    { id: 6, driverId: 8, typeId: 6, description: 'Trailer rental', frequency: 'Weekly', day: 'Friday', amount: 150, startDate: dayOff(-60), endDate: '', limit: 0, status: 'ACTIVE' },
    { id: 7, driverId: 20, typeId: 9, description: 'Escrow deposit', frequency: 'Weekly', day: 'Friday', amount: 100, startDate: dayOff(-150), endDate: dayOff(30), limit: 2500, status: 'ACTIVE' },
    { id: 8, driverId: 2, typeId: 5, description: 'ELD subscription', frequency: 'Monthly', day: '1', amount: 25, startDate: dayOff(-300), endDate: '', limit: 0, status: 'PAUSED' },
  ];
  const salBatches = [];
  let stSeq = 200;
  // Weekly periods, Saturday..Friday, ending 1 week ago and older. The current week's trips stay available.
  const weekEnd0 = -7; // Fri Oct 9
  const SB_WEEKS = 12;
  for (let w = SB_WEEKS - 1; w >= 0; w--) {
    const endD = weekEnd0 - 7 * w, startD = endD - 6;
    const id = 144 - w - 1 + 1 - 1 + 0; // placeholder replaced below
    salBatches.push({ week: w, from: dayOff(startD, 0, 0).slice(0, 10), to: dayOff(endD, 0, 0).slice(0, 10), startD, endD });
  }
  salBatches.forEach((b, k) => {
    b.id = 133 + k; // 133..144
    b.mcId = 1; b.timeType = 'Delivery time'; b.createdBy = pick(['Gary Thompson', 'Tutorial Account']); b.createdAt = dayOff(b.endD + 1, 9, 30); b.payBy = 'Demo';
    b.checkDate = dayOff(b.endD + 3, 0, 0).slice(0, 10); b.description = ''; b.settlements = []; b.events = [{ at: b.createdAt, text: 'Batch created' }];
    const trips = [];
    loads.forEach(L => { if (!L.deliveredAt || L.id === 12) return; const dd = L.deliveredAt.slice(0, 10); if (dd >= b.from && dd <= b.to) L.trips.forEach(t => { if (t.driverId) trips.push([L, t]); }); });
    const byDriver = new Map();
    trips.forEach(([L, t]) => { if (!byDriver.has(t.driverId)) byDriver.set(t.driverId, []); byDriver.get(t.driverId).push([L, t]); });
    const age = SB_WEEKS - 1 - k; // 0 = newest
    [...byDriver.entries()].forEach(([driverId, list]) => {
      const st = { id: 'ST-' + pad(++stSeq, 6), driverId, tripIds: list.map(([, t]) => t.id), status: age >= 3 ? 'PAID' : age === 2 ? 'UNPOSTED' : age === 1 ? 'POSTED' : 'UNPOSTED', emailSent: age >= 1 && age !== 2, items: [] };
      list.forEach(([L, t]) => { t.salaryBatchId = b.id; t.settlementId = st.id; });
      schedDeductions.filter(s => s.driverId === driverId && s.status === 'ACTIVE' && s.frequency === 'Weekly').forEach(s => st.items.push({ kind: 'deduction', typeId: s.typeId, description: s.description, qty: 1, rate: s.amount, scheduledId: s.id }));
      b.settlements.push(st);
    });
    if (b.id === 142 && !b.settlements.some(s => s.driverId === 11)) {
      // SB-000142 holds settlement ST-000256 for driver 11 (tutorial frame), built from load DT-000011's trip.
    }
  });
  // Make SB-000142 match the tutorial: unposted, includes the 8X71180 trip for driver 11 as ST-000256.
  const sb142 = salBatches.find(b => b.id === 142);
  if (sb142) {
    const L11 = loads[10]; const t11 = L11.trips[0];
    let st = sb142.settlements.find(s => s.driverId === 11);
    if (!st) { st = { id: 'ST-000256', driverId: 11, tripIds: [], status: 'UNPOSTED', emailSent: false, items: [] }; sb142.settlements.unshift(st); }
    st.id = 'ST-000256';
    if (t11 && !t11.salaryBatchId) { t11.salaryBatchId = 142; t11.settlementId = st.id; st.tripIds.push(t11.id); }
    if (!st.items.some(i => i.kind === 'deduction')) st.items.push({ kind: 'deduction', typeId: 1, description: 'Bobtail', qty: 1, rate: 200 });
    sb142.description = 'Weekly settlements';
    sb142.settlements.forEach(s => { s.status = 'UNPOSTED'; s.emailSent = false; });
  }
  salBatches.forEach(b => { b.status = b.settlements.length && b.settlements.every(s => s.status === 'PAID') ? 'PAID' : b.settlements.some(s => s.status === 'UNPOSTED') ? 'UNPOSTED' : 'POSTED'; delete b.week; delete b.startD; delete b.endD; });
  salBatches.sort((a, b) => b.id - a.id);
  loads.forEach(L => L.trips.forEach(t => { t.billing = t.salaryBatchId ? (salBatches.find(b => b.id === t.salaryBatchId).status === 'PAID' ? 'PAID' : 'IN BATCH') : 'PENDING'; }));

  // ---------- fuel ----------
  const fuelCards = activeDrivers.slice(0, 34).map((d, k) => ({ id: k + 1, number: '501486112467040' + pad(k * 3 + 11, 4), provider: 'EFS', driverId: d.id, truckId: d.truckId, status: k % 11 === 7 ? 'INACTIVE' : 'ACTIVE', limit: pick([800, 1000, 1200, 1500]), mcId: d.mcId }));
  fuelCards.forEach(c => { if (c.truckId) trucks[c.truckId - 1].fuelCard = c.number; });
  const STOPS = ['Flying J #612', "Love's #331", 'Pilot #4410', 'TA Travel Center #88', 'Petro #301', "Love's #702", 'Pilot #128', 'Flying J #719'];
  const fuelTx = [];
  for (let k = 0; k < 140; k++) {
    const card = fuelCards[(k * 7) % fuelCards.length];
    const product = k % 6 === 2 ? 'DEFD' : k % 9 === 4 ? 'ULSR' : 'ULSD';
    const qty = product === 'DEFD' ? r2(ri(5, 20) + rnd()) : r2(ri(40, 180) + rnd());
    const price = product === 'DEFD' ? 3.49 : product === 'ULSR' ? 3.19 : 3.89 - (k % 7) * 0.05;
    const retail = r2(qty * price), disc = product === 'ULSD' ? r2(qty * 0.42) : 0;
    const assigned = k % 5 !== 0;
    const c = CITIES[(k * 13) % CITIES.length];
    fuelTx.push({ id: k + 1, card: card.number, mcId: card.mcId, description: `${drivers[card.driverId - 1].first} ${drivers[card.driverId - 1].last}`, driverId: assigned ? card.driverId : null, truckId: assigned ? card.truckId : null,
      product, fee: k % 4 === 0 ? 3 : 0, misc: 0, qty, retail, net: r2(retail - disc), date: dayOff(-Math.floor(k / 3), 5 + (k % 14), (k * 17) % 60), location: `${pick(STOPS)}, ${c.city}, ${c.state}`, invoice: 'INV' + (880100 + k), source: k < 4 ? 'Manual' : 'EFS', fileId: k < 4 ? null : 1 + Math.floor(k / 40), settlementId: null });
  }
  const fuelFiles = [1, 2, 3, 4].map(n => ({ id: n, name: `efs-transactions-week-${41 - n}.csv`, provider: 'EFS', by: n % 2 ? 'Gary Thompson' : 'Tutorial Account', at: dayOff(-7 * n + 1, 7, 10), rows: 40, status: 'PROCESSED' }));

  // ---------- tolls ----------
  const transponders = trucks.slice(0, 40).map((t, k) => ({ id: k + 1, provider: k % 3 === 0 ? 'E-ZPass' : k % 3 === 1 ? 'PrePass' : 'iPass', number: (k % 3 === 0 ? '0' : '9') + pad(ri(10000000, 99999999), 9), truckId: t.id, status: 'ACTIVE' }));
  const PLAZAS = ['Dallas North Tollway', 'Sam Houston Tollway', 'I-90 Elgin Plaza', 'NJ Turnpike Exit 11', 'PA Turnpike Harrisburg', 'Ohio Turnpike Toledo', 'Indiana Toll Road Gary', 'Florida Turnpike Orlando', 'Kansas Turnpike Wichita', 'Oklahoma Turner Turnpike'];
  const tollTx = [];
  for (let k = 0; k < 90; k++) {
    const tp = transponders[(k * 5) % transponders.length]; const truck = trucks[tp.truckId - 1];
    const assigned = k % 6 !== 0;
    tollTx.push({ id: k + 1, provider: tp.provider, transponder: tp.number, plate: truck.plate, truckId: assigned ? truck.id : null, driverId: assigned ? truck.driverId : null, date: dayOff(-Math.floor(k / 3), 4 + (k % 18), (k * 23) % 60), agency: pick(['NTTA', 'HCTRA', 'ISTHA', 'NJTA', 'PTC', 'OTIC']), entry: pick(PLAZAS), exit: pick(PLAZAS), amount: r2(ri(3, 48) + rnd()), status: assigned ? 'Assigned' : 'Unassigned', fileId: 1 + Math.floor(k / 30), settlementId: null });
  }
  const tollFiles = [1, 2, 3].map(n => ({ id: n, name: `${['prepass', 'ezpass', 'ipass'][n - 1]}-statement-${pad(10 - n, 2)}-2026.csv`, provider: ['PrePass', 'E-ZPass', 'iPass'][n - 1], by: 'Gary Thompson', at: dayOff(-9 * n, 8, 0), rows: 30, status: 'PROCESSED' }));

  // ---------- money codes, cash advances ----------
  const moneyCodes = Array.from({ length: 24 }, (_, k) => { const d = activeDrivers[(k * 4) % 36]; return { id: k + 1, code: 'MC' + (73100000 + k * 1373), driverId: d.id, truckId: d.truckId, amount: pick([75, 120, 150, 200, 250, 300]), fee: pick([0, 2.5, 4]), purpose: pick(['Lumper', 'Repair', 'Advance', 'Scale ticket', 'Washout']), issued: dayOff(-k * 2, 10, 15), status: k % 7 === 3 ? 'VOID' : k < 5 ? 'ISSUED' : 'USED', deduct: k % 3 !== 1, loadId: loads[60 + k] ? loads[60 + k].id : null }; });
  const cashAdvances = Array.from({ length: 18 }, (_, k) => { const d = activeDrivers[(k * 5 + 2) % 36]; return { id: k + 1, driverId: d.id, amount: pick([100, 150, 200, 300, 500]), date: dayOff(-k * 3, 12, 0), method: pick(['Cash', 'Comchek', 'Bank transfer']), note: pick(['Road expenses', 'Requested by driver', 'Weekend advance', '']), settlementId: k > 8 ? 'ST-' + pad(220 + k, 6) : '', status: k > 8 ? 'DEDUCTED' : 'PENDING' }; });

  // ---------- bills, payroll, expenses, docs, integrations, misc ----------
  const bills = Array.from({ length: 22 }, (_, k) => { const t = trucks[(k * 3) % 50]; return { id: k + 1, number: 'BL-' + pad(500 + k, 6), payee: t.ownership === 'Owner operator' ? 'Carrier Test LLC' : pick(['Rush Truck Center', 'Lone Star Tire', 'Fleet Insurance Group', 'Wabash Rental', 'Yard Rent LLC']), truckId: t.id, category: pick(['Truck lease', 'Insurance', 'Repair', 'Tires', 'Trailer rent', 'Parking']), amount: pick([350, 420, 680, 1250, 1500, 2200, 95]), date: dayOff(-k * 4), due: dayOff(-k * 4 + 30), status: k < 6 ? 'UNPAID' : 'PAID', note: '' }; });
  const payrolls = Array.from({ length: 10 }, (_, k) => { const d = dispatchers[k % 5]; return { id: k + 1, number: 'PR-' + pad(60 + k, 6), dispatcherId: d.id, from: dayOff(-14 * (Math.floor(k / 5) + 1), 0, 0).slice(0, 10), to: dayOff(-14 * Math.floor(k / 5) - 1, 0, 0).slice(0, 10), loads: ri(6, 22), gross: ri(18000, 64000), rate: d.commission, status: k < 5 ? 'UNPOSTED' : 'PAID' }; });
  const expenses = ['Office rent', 'Software subscriptions', 'Insurance - cargo', 'Insurance - liability', 'Permits', 'IFTA filing', 'Drug testing', 'Parking', 'Phone & internet', 'Truck washes'].map((name, k) => ({ id: k + 1, name, category: k < 2 ? 'Office' : k < 4 ? 'Insurance' : 'Operations', default: [2500, 640, 1800, 2300, 300, 150, 75, 450, 220, 60][k], recurring: k % 2 === 0 }));
  const billExpenses = ['Truck lease', 'Insurance', 'Repair', 'Tires', 'Trailer rent', 'Parking', 'ELD', 'Plates'].map((name, k) => ({ id: k + 1, name, deductFromOwner: k !== 2, account: 5000 + k * 10 }));
  const docTypes = [
    ['Rate confirmation', 'Load', true, false], ['Proof of Delivery', 'Load', true, false], ['Bill of lading', 'Load', false, false], ['Lumper receipt', 'Load', false, false],
    ['CDL', 'Driver', true, true], ['Medical card', 'Driver', true, true], ['MVR', 'Driver', false, true], ['Drug test', 'Driver', false, true],
    ['Truck registration', 'Truck', true, true], ['Annual inspection', 'Truck', true, true], ['Insurance certificate', 'Truck', false, true], ['Trailer registration', 'Trailer', true, true],
  ].map(([name, applies, required, exp], k) => ({ id: k + 1, name, appliesTo: applies, required, expiration: exp }));
  const integrations = [
    { id: 'efs', name: 'EFS fuel cards', category: 'Fuel', status: 'Connected', account: 'EFS-****-2210', lastSync: dayOff(0, 6, 0) },
    { id: 'prepass', name: 'PrePass', category: 'Toll', status: 'Connected', account: 'PP-77120', lastSync: dayOff(-1, 6, 0) },
    { id: 'ezpass', name: 'E-ZPass', category: 'Toll', status: 'Not connected', account: '', lastSync: '' },
    { id: 'ipass', name: 'iPass', category: 'Toll', status: 'Not connected', account: '', lastSync: '' },
    { id: 'eld', name: 'ELD provider', category: 'Telematics', status: 'Connected', account: 'fleet-demo', lastSync: dayOff(0, 9, 0) },
    { id: 'telegram', name: 'Telegram bot', category: 'Messaging', status: 'Connected', account: '@roadledger_demo_bot', lastSync: dayOff(0, 9, 10) },
    { id: 'quickbooks', name: 'Accounting export', category: 'Accounting', status: 'Not connected', account: '', lastSync: '' },
    { id: 'amazon', name: 'Amazon Relay CSV', category: 'Loads', status: 'Connected', account: 'CSV import', lastSync: dayOff(-1, 15, 0) },
  ];
  const notifications = [
    { id: 1, text: 'Proof of Delivery uploaded for DT-000010', at: dayOff(-1, 15, 2), unread: true, href: '#/load-management/create-load/delivered/10/DT-000010' },
    { id: 2, text: 'Medical card expired: Komil Jalolov', at: dayOff(-1, 8, 0), unread: true, href: '#/hr-management/driver/drivers' },
    { id: 3, text: 'Batch IB-000149 is waiting to be sent', at: dayOff(-2, 9, 30), unread: true, href: '#/accounting/invoices/batches/view-batch/149' },
    { id: 4, text: 'EFS sync finished: 12 new transactions', at: dayOff(0, 6, 1), unread: false, href: '#/integrations/fuel/transactions' },
  ];
  const tasks = Array.from({ length: 12 }, (_, k) => ({ id: k + 1, title: ['Call broker about detention on DT-000033', 'Renew truck registration 2203', 'Collect POD for DT-000010', 'Review IFTA report Q3', 'Schedule annual inspection 718', 'Update driver pay tariff for Mark Butler', 'Verify insurance certificate for Best Carrier Company', 'Send settlement to Joe Topini', 'Check reefer unit on 89312', 'Onboard new driver Ethan Reed', 'Factoring schedule follow-up', 'Archive September loads'][k], assignee: pick(['Tutorial Account', 'Gary Thompson', 'Sam Carter', 'Ana Ruiz']), due: dayOff(k - 3), status: k < 4 ? 'Done' : k < 8 ? 'In progress' : 'To do', priority: pick(['High', 'Medium', 'Low']) }));
  const maintenance = Array.from({ length: 16 }, (_, k) => ({ id: k + 1, number: 'WO-' + pad(300 + k, 5), truckId: trucks[(k * 4) % 50].id, type: pick(['PM service', 'Tires', 'Brakes', 'Engine', 'Annual inspection', 'APU', 'Reefer service']), vendor: pick(['Rush Truck Center', 'TA Truck Service', 'Speedco', 'In-house shop']), opened: dayOff(-k * 5), closed: k < 4 ? '' : dayOff(-k * 5 + 2), cost: ri(180, 4200), status: k < 4 ? 'OPEN' : 'CLOSED', odometer: ri(150000, 700000) }));
  const safetyEvents = Array.from({ length: 10 }, (_, k) => ({ id: k + 1, kind: k % 3 === 0 ? 'Accident' : 'Inspection', driverId: activeDrivers[(k * 3) % 36].id, truckId: trucks[(k * 3) % 36].id, date: dayOff(-k * 9), location: `${CITIES[(k * 5) % CITIES.length].city}, ${CITIES[(k * 5) % CITIES.length].state}`, result: k % 3 === 0 ? 'Minor damage' : pick(['Clean', 'Violation: lights', 'Clean', 'Violation: logbook']), status: k < 3 ? 'OPEN' : 'CLOSED' }));

  const savedViews = {
    loads: [{ id: 'sv-amazon', name: "Today's Amazon Load", filter: { amazon: true } }, { id: 'sv-paid', name: 'Paid Loads', filter: { status: 'paid' } }],
    trucks: [{ id: 'sv-intransit', name: 'Intransit truck', filter: { status: 'IN TRANSIT' } }],
    drivers: [{ id: 'sv-company', name: 'Company Drivers', filter: { type: 'Company driver' } }],
    planning: [{ id: 'pl-intransit', name: 'In transit', filter: { status: 'in_transit' } }, { id: 'pl-available', name: 'Available', filter: { status: 'available' } }],
  };
  const config = { defaultMc: 1, mileageType: 'Google map', terms: 'Net 30', weekStart: 'Saturday', timezone: 'America/Chicago', currency: 'USD', autoEmpty: true, invoicePrefix: 'DT-', podRequired: true, statementSections: { earnings: true, deductions: true, otherPay: true, balances: true, fuel: true, toll: true, miles: true, logo: true } };

  RL.db = { mcs, customers, carriers, dispatchers, users, tariffs, trucks, trailers, drivers, loads, invBatches, salBatches, factoringCos, factoringSchedules, deductionTypes, schedDeductions,
    fuelCards, fuelTx, fuelFiles, transponders, tollTx, tollFiles, moneyCodes, cashAdvances, bills, payrolls, expenses, billExpenses, docTypes, integrations, notifications, tasks, maintenance, safetyEvents,
    savedViews, config, seq: { load: loads.length, stSeq, parse: 0 } };
  RL.ORDER = ORDER; RL.STATUS_TEXT = STATUS_TEXT; RL.FACILITIES = FACILITIES; RL.addTripRaw = addTrip;
})();
