import {
  PolicyReviewSchema,
  type PolicyReview,
  type PolicySource
} from "./schemas.js";

export function canonicalizePolicyReview(rawReview: unknown, sources: PolicySource[]): PolicyReview {
  const review = PolicyReviewSchema.parse(rawReview);
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const canonicalFindings = review.findings.map((finding) => {
    const source = sourcesById.get(finding.sourceId);
    if (!source) throw new Error(`Policy review referenced unknown source ${finding.sourceId}.`);
    return {
      ...finding,
      sourceType: source.sourceType,
      title: source.title,
      provider: source.provider,
      sourceReference: source.sourceReference
    };
  });
  return PolicyReviewSchema.parse({ ...review, findings: canonicalFindings });
}
