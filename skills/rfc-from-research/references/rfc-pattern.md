# RFC Pattern Reference

Use this reference when the RFC needs strategic synthesis, current-system comparison, or a reusable product recommendation.

## Accepted Shape

The accepted example used this flow:

1. **Sharp title**
   Name the product concept and strategic tension.

2. **Summary**
   State the product opportunity in plain English. Include the "not this, this" distinction early.

3. **Research Readout**
   Group sources by system type, not by a flat source list. Each cluster should end with a short implication for the target product.

   Good clusters:
   - Horizontal AI assistants
   - Work-management systems
   - Product-development systems
   - Research or academic signal
   - Contrarian or failure-mode signal

4. **Problem**
   Describe the concrete local behavior users optimize today and why that can still fail globally.

5. **Proposal**
   Give the concept a name. Define the smallest useful product unit and the repeated review question it answers.

6. **Approaches Considered**
   Include a familiar baseline, the recommended wedge, and a higher-upside follow-on. This makes the recommendation feel chosen, not assumed.

7. **Recommended Direction**
   Make the call directly. Avoid "it depends" unless the RFC is explicitly asking for decision criteria only.

8. **Experience**
   Show where the concept appears in the product. Keep this as user-visible behavior, not implementation architecture.

9. **MVP Scope**
   Collapse the idea to one real workflow, one decision, one initiative, one customer segment, or similar.

10. **Non-Goals**
    Block adjacent-product drift.

11. **Success Criteria**
    Combine qualitative proof with measurable proxies.

12. **Risks and Open Questions**
    Surface false certainty, incentives, source completeness, and adoption overhead.

13. **Source Notes**
    List every source used with a one-line relevance note.

## Moves Worth Preserving

- The research readout was useful because each section said what that category implied for the product.
- The proposal avoided a generic "AI prioritization" claim and instead named an ergonomic product surface.
- The RFC used "one real initiative and one decision" to keep the MVP credible.
- The risks protected against false certainty, political friction, incomplete context, metric gaming, and governance overhead.
- The source notes made the provenance boundary explicit without turning the RFC into an academic bibliography.

## Red Flags

- If the RFC could apply to any SaaS company, sharpen the product wedge.
- If the research section can be deleted without changing the proposal, rewrite the research section.
- If the MVP needs a full platform, shrink it to a single reviewed decision.
- If the recommendation is hidden in the middle, add a `Recommended Direction` section.
- If sources are summarized but not linked, add source notes before finishing.
