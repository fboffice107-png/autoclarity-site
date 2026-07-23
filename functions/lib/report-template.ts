// The inspection checklist template — the single source of truth for report
// sections and items. Stored data references these keys; the template version
// is recorded on every report so the checklist can evolve without corrupting
// older reports. No inspection-point COUNT is advertised anywhere — the
// checklist is what it is, honestly.

export const REPORT_TEMPLATE_KEY = 'ppi';
export const REPORT_TEMPLATE_VERSION = 1;

export const ITEM_RESULTS = ['pass', 'attention', 'fail', 'not_inspected', 'not_applicable'] as const;
export type ItemResult = (typeof ITEM_RESULTS)[number];

export const NOT_INSPECTED_REASONS = [
  'not_accessible',
  'unsafe_to_test',
  'seller_declined',
  'equipment_unavailable',
  'not_supported',
] as const;
export type NotInspectedReason = (typeof NOT_INSPECTED_REASONS)[number];

export const NOT_INSPECTED_REASON_LABELS: Record<NotInspectedReason, string> = {
  not_accessible: 'Not accessible',
  unsafe_to_test: 'Unsafe to test',
  seller_declined: 'Seller declined',
  equipment_unavailable: 'Equipment unavailable',
  not_supported: 'Not supported on this vehicle',
};

export const SECTION_PERFORMED = ['performed', 'partial', 'not_performed'] as const;
export const SECTION_NOT_PERFORMED_REASONS = [...NOT_INSPECTED_REASONS, 'not_applicable'] as const;

export const PRIORITIES = ['immediate', 'soon', 'monitor', 'informational'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  immediate: 'Immediate',
  soon: 'Soon',
  monitor: 'Monitor',
  informational: 'Informational',
};

export const VERDICTS = ['proceed', 'negotiate_repair_first', 'do_not_proceed'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  proceed: 'Proceed',
  negotiate_repair_first: 'Negotiate / Repair First',
  do_not_proceed: 'Do Not Proceed',
};

export interface ReportItemDef {
  key: string; // globally unique, dot-namespaced by section
  label: string;
  hint?: string; // inspector-facing guidance
  measurement?: { unit: string; label?: string };
}

export interface ReportSectionDef {
  key: string;
  title: string;
  /** Sections only performed when actually possible/permitted/safe. */
  conditional?: boolean;
  conditionNote?: string;
  items: ReportItemDef[];
}

function item(section: string, k: string, label: string, hint?: string, measurement?: { unit: string; label?: string }): ReportItemDef {
  return { key: `${section}.${k}`, label, ...(hint ? { hint } : {}), ...(measurement ? { measurement } : {}) };
}

export const REPORT_SECTIONS: ReportSectionDef[] = [
  {
    key: 'exterior_body',
    title: 'Exterior Body & Paint',
    items: [
      item('exterior_body', 'paint_condition', 'Paint condition', 'Fade, clear-coat failure, scratches, chips'),
      item('exterior_body', 'panel_alignment', 'Panel alignment & gaps'),
      item('exterior_body', 'doors_hood_trunk', 'Doors, hood & trunk operation', 'Open/close/latch effort, hinges'),
      item('exterior_body', 'rust_corrosion', 'Rust / corrosion'),
      item('exterior_body', 'body_trim', 'Body trim & moldings'),
      item('exterior_body', 'bumpers_condition', 'Bumper condition'),
    ],
  },
  {
    key: 'collision_repair',
    title: 'Collision / Repair Indicators',
    items: [
      item('collision_repair', 'paint_meter', 'Paint-thickness spot checks', 'Note readings/panels in measurement + notes', { unit: 'mils' }),
      item('collision_repair', 'repaint_evidence', 'Repaint evidence', 'Overspray, masking lines, texture mismatch'),
      item('collision_repair', 'panel_replacement', 'Panel replacement indicators', 'Fastener witness marks, seam sealer'),
      item('collision_repair', 'structural_evidence', 'Structural repair evidence', 'Rails, aprons, core support — visible areas'),
      item('collision_repair', 'glass_date_match', 'Glass date-code consistency'),
    ],
  },
  {
    key: 'glass_lamps',
    title: 'Glass, Lamps & Exterior Equipment',
    items: [
      item('glass_lamps', 'windshield', 'Windshield', 'Chips, cracks, prior repairs, wiper haze'),
      item('glass_lamps', 'other_glass_mirrors', 'Other glass & mirrors'),
      item('glass_lamps', 'headlamps', 'Headlamps (low/high)', 'Function + lens clarity'),
      item('glass_lamps', 'tail_brake_lamps', 'Tail & brake lamps'),
      item('glass_lamps', 'signals_markers', 'Turn signals & markers'),
      item('glass_lamps', 'wipers_washers', 'Wipers & washers'),
    ],
  },
  {
    key: 'tires_wheels',
    title: 'Tires & Wheels',
    items: [
      item('tires_wheels', 'tread_fl', 'Front-left tire tread', undefined, { unit: '32nds in', label: 'Tread depth' }),
      item('tires_wheels', 'tread_fr', 'Front-right tire tread', undefined, { unit: '32nds in', label: 'Tread depth' }),
      item('tires_wheels', 'tread_rl', 'Rear-left tire tread', undefined, { unit: '32nds in', label: 'Tread depth' }),
      item('tires_wheels', 'tread_rr', 'Rear-right tire tread', undefined, { unit: '32nds in', label: 'Tread depth' }),
      item('tires_wheels', 'tire_age', 'Tire age (DOT date codes)', 'Note oldest date code', { unit: 'yrs', label: 'Oldest tire age' }),
      item('tires_wheels', 'tire_match', 'Tire match & condition', 'Brand/model match, dry rot, plugs, uneven wear'),
      item('tires_wheels', 'wheels_condition', 'Wheel condition', 'Curb rash, bends, cracks, aftermarket fitment'),
      item('tires_wheels', 'spare_kit', 'Spare / inflator kit'),
    ],
  },
  {
    key: 'brakes',
    title: 'Brake Condition & Measurements',
    items: [
      item('brakes', 'front_pads', 'Front brake pads', 'Estimated remaining material', { unit: 'mm', label: 'Pad thickness' }),
      item('brakes', 'rear_pads', 'Rear brake pads', 'Estimated remaining material', { unit: 'mm', label: 'Pad thickness' }),
      item('brakes', 'rotors_drums', 'Rotors / drums', 'Scoring, lips, heat checking'),
      item('brakes', 'lines_hoses', 'Brake lines & hoses (visible)'),
      item('brakes', 'parking_brake', 'Parking brake'),
      item('brakes', 'brake_fluid', 'Brake fluid level & condition'),
    ],
  },
  {
    key: 'steering_suspension',
    title: 'Steering & Suspension',
    items: [
      item('steering_suspension', 'steering_play', 'Steering play / response'),
      item('steering_suspension', 'power_steering', 'Power-steering operation', 'Noise, fluid where applicable'),
      item('steering_suspension', 'struts_shocks', 'Struts & shocks', 'Leakage, bounce response'),
      item('steering_suspension', 'springs_ride_height', 'Springs & ride height'),
      item('steering_suspension', 'arms_bushings', 'Control arms & bushings (visible)'),
      item('steering_suspension', 'joints_tie_rods', 'Ball joints & tie rods (visible)'),
      item('steering_suspension', 'wear_pattern', 'Alignment wear indicators', 'Tire wear pattern, off-center wheel'),
    ],
  },
  {
    key: 'engine',
    title: 'Engine Condition & Visible Leaks',
    items: [
      item('engine', 'cold_start', 'Cold start behavior', 'Note if the engine was already warm on arrival'),
      item('engine', 'idle_quality', 'Idle quality'),
      item('engine', 'engine_noises', 'Abnormal engine noises', 'Ticks, knocks, rattles, belt noise'),
      item('engine', 'oil_leaks', 'Visible oil leaks', 'Valve cover, oil pan, timing cover, seals'),
      item('engine', 'oil_level_condition', 'Oil level & condition'),
      item('engine', 'belts', 'Drive belts'),
      item('engine', 'hoses_visible', 'Hoses (visible)'),
      item('engine', 'engine_mounts', 'Engine mounts (visual/load check)'),
      item('engine', 'air_intake', 'Air intake & filter'),
      item('engine', 'forced_induction', 'Turbo / supercharger (if equipped)', 'Boost leaks, shaft play where accessible'),
    ],
  },
  {
    key: 'cooling',
    title: 'Cooling System',
    items: [
      item('cooling', 'coolant_level', 'Coolant level & condition'),
      item('cooling', 'radiator', 'Radiator & cap (visible)'),
      item('cooling', 'cooling_hoses', 'Cooling hoses & clamps'),
      item('cooling', 'cooling_fans', 'Cooling fans'),
      item('cooling', 'coolant_leaks', 'Coolant leaks / residue'),
    ],
  },
  {
    key: 'transmission_drivetrain',
    title: 'Transmission & Drivetrain',
    items: [
      item('transmission_drivetrain', 'trans_leaks', 'Transmission fluid leaks'),
      item('transmission_drivetrain', 'engagement', 'Gear engagement (P/R/N/D)', 'Delay, flare, clunk at engagement'),
      item('transmission_drivetrain', 'clutch', 'Clutch operation (manual)', 'Mark N/A for automatics'),
      item('transmission_drivetrain', 'axles_boots', 'Driveshaft, axles & CV boots (visible)'),
      item('transmission_drivetrain', 'diff_tcase', 'Differential / transfer case (visible)', 'Leaks; mark N/A where not fitted'),
    ],
  },
  {
    key: 'battery_charging',
    title: 'Battery, Starting & Charging',
    items: [
      item('battery_charging', 'battery_condition', 'Battery condition / test', 'Resting voltage or tester result', { unit: 'V', label: 'Resting voltage' }),
      item('battery_charging', 'terminals', 'Terminals & mounting', 'Corrosion, hold-down'),
      item('battery_charging', 'charging_output', 'Charging output (running)', undefined, { unit: 'V', label: 'Charging voltage' }),
      item('battery_charging', 'starter', 'Starter engagement'),
    ],
  },
  {
    key: 'interior',
    title: 'Interior Condition',
    items: [
      item('interior', 'seats_upholstery', 'Seats & upholstery'),
      item('interior', 'carpets_headliner', 'Carpets & headliner', 'Water staining, odor sources'),
      item('interior', 'odors', 'Odors (smoke / water / mildew)'),
      item('interior', 'door_panels', 'Door panels & handles'),
      item('interior', 'windows_power', 'Window operation (all)'),
      item('interior', 'locks_keys', 'Locks, keys & fobs', 'Number of keys/fobs present'),
      item('interior', 'sunroof', 'Sunroof / convertible top (if equipped)'),
    ],
  },
  {
    key: 'safety_restraints',
    title: 'Seats, Restraints & Safety Equipment',
    items: [
      item('safety_restraints', 'seat_belts', 'Seat belts (all positions)', 'Latch, retract, webbing condition'),
      item('safety_restraints', 'airbag_lamp', 'Airbag (SRS) lamp behavior', 'Bulb check on start, then off'),
      item('safety_restraints', 'child_anchors', 'Child-seat anchors (LATCH)'),
      item('safety_restraints', 'horn', 'Horn'),
      item('safety_restraints', 'hazards', 'Hazard lights'),
    ],
  },
  {
    key: 'electronics',
    title: 'Electronics & Accessories',
    items: [
      item('electronics', 'infotainment', 'Infotainment / display'),
      item('electronics', 'audio', 'Audio system & speakers'),
      item('electronics', 'cameras_sensors', 'Cameras & parking sensors'),
      item('electronics', 'power_accessories', 'Power accessories', 'Mirrors, seats, steering wheel, liftgate'),
      item('electronics', 'usb_power', '12V / USB power ports'),
    ],
  },
  {
    key: 'hvac',
    title: 'Heating & Air Conditioning',
    items: [
      item('hvac', 'ac_output', 'A/C cold output', 'Center-vent temperature after stabilizing', { unit: '°F', label: 'Vent temp' }),
      item('hvac', 'heat_output', 'Heat output'),
      item('hvac', 'blower_modes', 'Blower speeds & mode doors'),
      item('hvac', 'defrost', 'Defrost (front & rear)'),
    ],
  },
  {
    key: 'instruments',
    title: 'Instrument Cluster & Warning Lights',
    items: [
      item('instruments', 'cluster_function', 'Cluster / gauge function'),
      item('instruments', 'odometer_function', 'Odometer function'),
      item('instruments', 'warning_lights', 'Warning lights present', 'CEL, ABS, SRS, TPMS, oil, temp — list in notes'),
      item('instruments', 'tpms', 'TPMS status'),
    ],
  },
  {
    key: 'diagnostic_scan',
    title: 'Diagnostic Scan',
    conditional: true,
    conditionNote: 'Only when a scan was actually performed with permission and a scan tool on site.',
    items: [
      item('diagnostic_scan', 'stored_codes', 'Stored trouble codes', 'List codes in notes'),
      item('diagnostic_scan', 'pending_codes', 'Pending codes'),
      item('diagnostic_scan', 'readiness', 'Emissions readiness monitors', 'Only when actually read; note not-ready monitors'),
      item('diagnostic_scan', 'scan_summary', 'Module scan summary'),
    ],
  },
  {
    key: 'road_test',
    title: 'Road Test',
    conditional: true,
    conditionNote: 'Only when permitted by the seller and safe/legal to perform.',
    items: [
      item('road_test', 'driveability', 'Start & driveability'),
      item('road_test', 'acceleration', 'Acceleration & power delivery'),
      item('road_test', 'trans_behavior', 'Transmission behavior under load'),
      item('road_test', 'braking', 'Braking performance', 'Straight stop, pedal feel, pulsation'),
      item('road_test', 'steering_tracking', 'Steering & tracking', 'On-center feel, pull, wander'),
      item('road_test', 'noises_vibrations', 'Noises & vibrations at speed'),
      item('road_test', 'cruise_adas', 'Cruise / driver-assist basics'),
    ],
  },
  {
    key: 'underbody',
    title: 'Underbody Inspection',
    conditional: true,
    conditionNote: 'To the extent safely accessible at the location (no lift assumed).',
    items: [
      item('underbody', 'structure', 'Frame / structure (visible)'),
      item('underbody', 'underbody_corrosion', 'Underbody corrosion'),
      item('underbody', 'underbody_leaks', 'Leaks from below'),
      item('underbody', 'exhaust', 'Exhaust system'),
      item('underbody', 'suspension_under', 'Suspension from below (visible)'),
      item('underbody', 'damage_repair', 'Underbody damage / repair evidence'),
    ],
  },
];

// ------------------------------------------------------------------ lookups

const SECTION_BY_KEY = new Map(REPORT_SECTIONS.map((s) => [s.key, s]));
const ITEM_INDEX = new Map<string, { section: ReportSectionDef; def: ReportItemDef }>();
for (const s of REPORT_SECTIONS) for (const d of s.items) ITEM_INDEX.set(d.key, { section: s, def: d });

export function sectionDef(key: string): ReportSectionDef | undefined {
  return SECTION_BY_KEY.get(key);
}

export function itemDef(key: string): { section: ReportSectionDef; def: ReportItemDef } | undefined {
  return ITEM_INDEX.get(key);
}

export function allItemKeys(): string[] {
  return [...ITEM_INDEX.keys()];
}

/** The standard, non-removable limitations text included in every report. */
export const STANDARD_LIMITATIONS =
  'This inspection is a professional opinion of the vehicle’s observable condition at the time and place of ' +
  'inspection. It is visual and non-invasive unless expressly stated; components are not disassembled. Hidden, ' +
  'intermittent, or future failures may not be detectable. Seller permission, access and location conditions can ' +
  'limit what is possible; anything not inspected is identified with the reason. Repair-cost figures are good-faith ' +
  'estimates for budgeting and negotiation, not repair quotes. A pre-purchase inspection is not a warranty or a ' +
  'guarantee of the vehicle’s condition or future reliability, and the purchase decision remains entirely with the buyer.';
