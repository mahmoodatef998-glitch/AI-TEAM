/**
 * Business taxonomy used by qualification and assignment.
 * Industries considered relevant for diesel generator demand (backup / prime power).
 */
export const INDUSTRIES: Record<string, { label: string; relevance: "high" | "medium" | "low" }> = {
  construction: { label: "Construction", relevance: "high" },
  mep_contractor: { label: "MEP Contractor", relevance: "high" },
  oil_and_gas: { label: "Oil & Gas", relevance: "high" },
  data_center: { label: "Data Center", relevance: "high" },
  hospital: { label: "Hospital / Healthcare", relevance: "high" },
  telecom: { label: "Telecom Infrastructure", relevance: "high" },
  manufacturing: { label: "Manufacturing / Factory", relevance: "high" },
  infrastructure: { label: "Infrastructure", relevance: "high" },
  utilities: { label: "Utilities", relevance: "high" },
  generator_reseller: { label: "Generator Reseller / Rental", relevance: "high" },
  warehousing_logistics: { label: "Warehousing & Logistics", relevance: "medium" },
  hospitality: { label: "Hotels & Hospitality", relevance: "medium" },
  real_estate: { label: "Real Estate Development", relevance: "medium" },
  agriculture: { label: "Agriculture / Farms", relevance: "medium" },
  government: { label: "Government / Semi-government", relevance: "medium" },
  education: { label: "Education", relevance: "medium" },
  retail: { label: "Retail / Malls", relevance: "medium" },
  events: { label: "Events", relevance: "medium" },
  other: { label: "Other", relevance: "low" },
};

export const ACCOUNT_TYPES = ["end_user", "contractor", "reseller", "consultant", "key_account"] as const;

/** Primary markets: UAE first, then GCC, then wider MENA/Africa export markets. */
export const MARKETS = {
  primary: ["UAE"],
  secondary: ["Saudi Arabia", "Oman", "Qatar", "Kuwait", "Bahrain"],
  export: ["Iraq", "Jordan", "Egypt", "Kenya", "Nigeria", "Tanzania", "Ethiopia", "Sudan", "Yemen", "Afghanistan", "Pakistan"],
};

export const DECISION_MAKER_TITLES = [
  "procurement", "purchasing", "buyer", "supply chain", "project manager", "projects director",
  "mep manager", "electrical engineer", "facility manager", "facilities", "operations director",
  "plant manager", "general manager", "ceo", "managing director", "owner", "technical director", "estimator",
];

export const PURCHASE_TIMING = ["immediate", "within_3_months", "within_12_months", "unknown"] as const;
