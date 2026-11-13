import type { Skill } from "./types";
import { dailyBriefing, dailyPerformanceReport, kpiPlan, weeklyExecMeeting } from "./skills/executive";
import { leadDiscover, leadQualify, leadResearch } from "./skills/leadgen";
import { adsReview, competitorResearch, contentDraft, marketingPlan, seoAudit } from "./skills/marketing";
import { followUpPrepare, leadAssign, opportunityOnboard, outreachDraft, pipelineReview, salesReviewMeeting } from "./skills/sales";
import { rfqAnalyze } from "./skills/technical";
import { assignmentWork } from "./skills/assignment";

/** Skills every employee may perform, regardless of their role's skill list. */
export const UNIVERSAL_SKILLS = new Set([assignmentWork.type]);

const ALL: Skill[] = [
  assignmentWork,
  kpiPlan, dailyBriefing, weeklyExecMeeting, dailyPerformanceReport,
  leadAssign, pipelineReview, salesReviewMeeting, opportunityOnboard, outreachDraft, followUpPrepare,
  leadDiscover, leadResearch, leadQualify,
  rfqAnalyze,
  seoAudit, adsReview, contentDraft, competitorResearch, marketingPlan,
];

export const SKILLS: Record<string, Skill> = Object.fromEntries(ALL.map((s) => [s.type, s]));
export const getSkill = (type: string): Skill | undefined => SKILLS[type];
