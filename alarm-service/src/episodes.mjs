// Alarm levels: a passage includes an intrusion, which includes an approach, which
// includes an appearance. One activity per channel and target keeps the highest.
// (Contact and line crossing are levels of earlier configurations, kept for history.)
export const stageRank={appearance:0,region_approach:1,region_contact:2,region_enter:3,region_traverse:4,line_crossing:4};
