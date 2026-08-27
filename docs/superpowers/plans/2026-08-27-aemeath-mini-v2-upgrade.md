# Aemeath Mini V2 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing `aemeath-mini` local Codex pet from the 9-row v1 atlas to the 11-row v2 atlas with 16 readable clockwise look directions, while preserving its approved standard animations.

**Architecture:** The existing 1536x1872 source sheet is the preserved identity and rows 0-8 baseline. New cardinal anchors and two coherent eight-pose look strips are generated from that baseline, normalized with the hatch-pet deterministic scripts, assembled with the preserved base atlas, then validated and atomically installed only after visual and structural QA pass.

**Tech Stack:** Codex hatch-pet skill, built-in `image_gen`, bundled Python runtime with Pillow, local WebP/PNG sprite atlases, PowerShell.

## Execution Status

- [x] Getting Aemeath Mini ready.
- [x] Imagining Aemeath Mini's main look.
- [x] Picturing Aemeath Mini's poses.
- [x] Hatching Aemeath Mini.

**Completion note (2026-08-27):** The v2 package is installed under `C:\Users\Administrator\.codex\pets\aemeath-mini`. Its original standard animation cells were verified against the v1 backup after installation; all direction and structural QA evidence is in `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827-final\qa`.

## Global Constraints

- Preserve the existing rows 0-8; do not regenerate or change their visual behavior.
- Keep the pet identity: Q-style pixel art, pink hair, cyan halo, white-blue mechanical clothing, compact full-body silhouette.
- Generate only the visual direction source assets with built-in `image_gen`; use hatch-pet scripts only for deterministic extraction, registration, assembly, cleanup, and QA.
- Direction meanings use viewer coordinates: 000 up, 090 screen-right, 180 down, 270 screen-left.
- Do not use whole-sprite rotation, detached effects, shadows, labels, or guide marks in generated visual rows.
- Do not modify `C:\Users\Administrator\.codex\pets\aemeath-mini` until all v2 gates pass. Create rollback copies before package replacement.
- Use `C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe` for every hatch-pet script.
- No Git commit is included: the target custom-pet package is outside the dirty source repository, whose unrelated user changes must remain untouched.

---

### Task 1: Preserve and Validate the V1 Baseline

**Files:**
- Read: `C:\Users\Administrator\.codex\pets\aemeath-mini\spritesheet.webp`
- Read: `C:\Users\Administrator\.codex\pets\aemeath-mini\pet.json`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\source\spritesheet-v1.webp`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\source\pet-v1.json`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\validation-source-v1.json`

**Interfaces:**
- Consumes: Existing v1 atlas `1536x1872` and manifest.
- Produces: Immutable v1 source copy and evidence that rows 0-8 have the expected occupied cells.

- [ ] **Step 1: Copy source files into the isolated run directory**

```powershell
$run = 'C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827'
New-Item -ItemType Directory -Force -Path "$run\source", "$run\qa" | Out-Null
Copy-Item -LiteralPath 'C:\Users\Administrator\.codex\pets\aemeath-mini\spritesheet.webp' -Destination "$run\source\spritesheet-v1.webp"
Copy-Item -LiteralPath 'C:\Users\Administrator\.codex\pets\aemeath-mini\pet.json' -Destination "$run\source\pet-v1.json"
```

- [ ] **Step 2: Record baseline validation and dimensions**

```powershell
$python = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$skill = 'C:\Users\Administrator\.codex\skills\hatch-pet'
& $python "$skill\scripts\validate_atlas.py" "$run\source\spritesheet-v1.webp" --json-out "$run\qa\validation-source-v1.json"
& $python -c "from PIL import Image; print(Image.open(r'$run\source\spritesheet-v1.webp').size)"
```

Expected: Source reports a 9-row v1 atlas. Transparent RGB residue is expected source evidence and is resolved only by the single v2 post-assembly despill pass.

- [ ] **Step 3: Create the reusable standard-animation intermediate**

```powershell
Copy-Item -LiteralPath "$run\source\spritesheet-v1.webp" -Destination "$run\final\spritesheet.webp" -Force
```

Expected: The later extended-assembly script receives `final\spritesheet.webp` as its rows 0-8 base.

### Task 2: Generate and Approve Cardinal Direction Anchors

**Files:**
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\references\canonical-base.png`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\look-mechanics.md`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\decoded\look-cardinals.png`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\decoded\look-anchors-approved.png`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\cardinal-anchors.json`

**Interfaces:**
- Consumes: Source atlas and a neutral idle frame.
- Produces: Approved 000/090/180/270 anchor strip for both look rows.

- [ ] **Step 1: Extract an idle frame for identity grounding**

```powershell
& $python -c "from PIL import Image; im=Image.open(r'$run\source\spritesheet-v1.webp').convert('RGBA'); im.crop((0,0,192,208)).save(r'$run\references\canonical-base.png')"
```

- [ ] **Step 2: Write the mechanics decision**

`qa\look-mechanics.md` must define these fixed mechanics:

```markdown
# Aemeath Mini Look Mechanics

- Stable anchor: feet, torso center, halo position, scale, and lower-body baseline remain stable.
- Gaze leaders: irises, eyelids, brows, face angle, and a restrained head/upper-body turn carry direction.
- Follow-through: hair fringe and side hair follow the head turn by one small visual step; the halo stays centered over the head without rotating the full sprite.
- 000 up: pupils and face angle rise, eyelids open slightly, chin lifts.
- 090 screen-right: pupils, nose/face surface, head and hair turn toward the viewer's right; the near side of the face becomes more visible.
- 180 down: pupils lower, eyelids narrow, chin and upper body settle slightly forward.
- 270 screen-left: mirror the 090 facial relationship toward the viewer's left while preserving the same halo and clothing identity.
- Motion budget: adjacent 22.5-degree poses use only one small equal change in face/head/hair presentation; no full-sprite rotation, scale pop, or baseline shift.
```

- [ ] **Step 3: Generate a four-cell cardinal strip with `image_gen`**

Use the source atlas, canonical idle frame, layout guide, and the mechanics document as references. Require four horizontally separated cells in this exact order: `000 up`, `090 screen-right`, `180 down`, `270 screen-left`.

- [ ] **Step 4: Extract and structurally validate cardinal anchors**

```powershell
& $python "$skill\scripts\extract_cardinal_anchors.py" `
  --strip "$run\decoded\look-cardinals.png" `
  --output-dir "$run\decoded\look-anchors" `
  --chroma-key '#00FF00' `
  --json-out "$run\qa\cardinal-anchors.json"
& $python "$skill\scripts\compose_cardinal_anchor_strip.py" `
  --anchors-dir "$run\decoded\look-anchors" `
  --output "$run\decoded\look-anchors-approved.png"
```

- [ ] **Step 5: Run an independent visual cardinal review**

Acceptance: 000 unmistakably looks up, 090 looks toward screen-right, 180 looks down, and 270 looks toward screen-left at normal pet size. Regenerate the failing anchor only if a cardinal is ambiguous or wrong.

### Task 3: Generate and Register the Two Coherent Look Rows

**Files:**
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\decoded\look-row-9.png`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\look-row-9-registered.png`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\look-row-9-registration.json`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\decoded\look-row-10.png`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\final\spritesheet-extended.webp`

**Interfaces:**
- Consumes: Approved cardinal anchor strip, base atlas, idle neutral cell, mechanics decision.
- Produces: 16 direction cells in required clockwise order with shared registration.

- [ ] **Step 1: Generate coherent row 9**

Generate eight horizontally separated poses in exact order: `000`, `022.5`, `045`, `067.5`, `090`, `112.5`, `135`, `157.5`. Ground it with the source atlas, canonical idle frame, approved cardinal strip, mechanics document, and the row-9 layout guide. Reject guide pixels, detached effects, whole-sprite rotation, or front-facing repetition.

- [ ] **Step 2: Register row 9 and check final-cell boundaries**

```powershell
& $python "$skill\scripts\assemble_extended_atlas.py" `
  --base-atlas "$run\final\spritesheet.webp" `
  --look-row-9 "$run\decoded\look-row-9.png" `
  --neutral-cell "$run\references\canonical-base.png" `
  --chroma-key '#00FF00' `
  --chroma-threshold 96 `
  --registered-row-output "$run\qa\look-row-9-registered.png" `
  --registration-manifest-output "$run\qa\look-row-9-registration.json"
```

- [ ] **Step 3: Review row-9 semantics and continuity before row 10**

Acceptance: all eight poses advance continuously from up through screen-right toward down; no cropping, scale jumps, wrong quadrant, or direction reversal. A hard failure regenerates the complete row 9.

- [ ] **Step 4: Generate coherent row 10**

Generate eight horizontally separated poses in exact order: `180`, `202.5`, `225`, `247.5`, `270`, `292.5`, `315`, `337.5`. Ground it with the source atlas, canonical idle frame, approved cardinal strip, registered row 9, mechanics document, and the row-10 layout guide.

- [ ] **Step 5: Assemble the extended atlas**

```powershell
& $python "$skill\scripts\assemble_extended_atlas.py" `
  --base-atlas "$run\final\spritesheet.webp" `
  --registered-row-9 "$run\qa\look-row-9-registered.png" `
  --row-9-registration "$run\qa\look-row-9-registration.json" `
  --look-row-10 "$run\decoded\look-row-10.png" `
  --neutral-cell "$run\references\canonical-base.png" `
  --chroma-key '#00FF00' `
  --chroma-threshold 96 `
  --output "$run\final\spritesheet-extended.png" `
  --webp-output "$run\final\spritesheet-extended.webp" `
  --manifest-output "$run\final\spritesheet-extended.json"
```

### Task 4: Complete V2 QA and Install with Rollback Safety

**Files:**
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\chroma-despill-extended.json`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\final\validation-extended.json`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\contact-sheet-extended.png`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\look-directions.png`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\direction-semantics.json`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\direction-blind-validation.json`
- Create: `C:\Users\Administrator\.codex\pets\aemeath-mini-v2-upgrade-20260827\qa\look-continuity.json`
- Modify after pass: `C:\Users\Administrator\.codex\pets\aemeath-mini\spritesheet.webp`
- Modify after pass: `C:\Users\Administrator\.codex\pets\aemeath-mini\pet.json`
- Create before modification: `C:\Users\Administrator\.codex\pets\aemeath-mini\spritesheet-v1-backup-20260827.webp`
- Create before modification: `C:\Users\Administrator\.codex\pets\aemeath-mini\pet-v1-backup-20260827.json`

**Interfaces:**
- Consumes: Assembled v2 atlas.
- Produces: Validated v2 package with rollback copies.

- [ ] **Step 1: Run the sole chroma cleanup pass**

```powershell
& $python "$skill\scripts\despill_chroma_edges.py" `
  "$run\final\spritesheet-extended.png" `
  --output "$run\final\spritesheet-extended.png" `
  --webp-output "$run\final\spritesheet-extended.webp" `
  --chroma-key '#00FF00' `
  --json-out "$run\qa\chroma-despill-extended.json"
```

- [ ] **Step 2: Validate the v2 structural contract**

```powershell
& $python "$skill\scripts\validate_atlas.py" `
  "$run\final\spritesheet-extended.webp" `
  --json-out "$run\final\validation-extended.json" `
  --chroma-key '#00FF00' `
  --require-v2
```

Expected: `ok: true`, dimensions `1536x2288`, 11 rows, all used cells non-empty, unused standard cells fully transparent, no opaque chroma-key pixels, and no transparent RGB residue.

- [ ] **Step 3: Create visual review artifacts**

```powershell
& $python "$skill\scripts\make_contact_sheet.py" "$run\final\spritesheet-extended.webp" --output "$run\qa\contact-sheet-extended.png"
& $python "$skill\scripts\make_direction_qa_sheet.py" "$run\final\spritesheet-extended.webp" --output "$run\qa\look-directions.png"
& $python "$skill\scripts\measure_direction_continuity.py" "$run\final\spritesheet-extended.webp" --json-out "$run\qa\look-continuity.json"
& $python "$skill\scripts\make_direction_blind_qa_sheet.py" `
  "$run\final\spritesheet-extended.webp" `
  --output "$run\qa\direction-blind-pairs.png" `
  --answer-key "$run\qa\direction-blind-answer-key.json"
```

- [ ] **Step 4: Obtain three independent blind axis verdicts and validate consensus**

Each reviewer only receives `direction-blind-pairs.png`. Combine their JSON results, apply the hidden answer key, and require passing cardinal pairs.

```powershell
& $python "$skill\scripts\combine_direction_blind_verdicts.py" `
  --verdicts "$run\qa\direction-blind-verdicts-1.json" `
  --verdicts "$run\qa\direction-blind-verdicts-2.json" `
  --verdicts "$run\qa\direction-blind-verdicts-3.json" `
  --json-out "$run\qa\direction-blind-verdicts.json"
& $python "$skill\scripts\validate_direction_blind_verdicts.py" `
  --answer-key "$run\qa\direction-blind-answer-key.json" `
  --verdicts "$run\qa\direction-blind-verdicts.json" `
  --json-out "$run\qa\direction-blind-validation.json"
```

- [ ] **Step 5: Record all 16 labeled semantic verdicts**

Write `qa\direction-semantics.json` with `verdict`, `expected`, `observed`, and Chinese `reason` for every direction. Cardinals must be `pass`; intermediate warnings are acceptable only when the ordered loop remains visually coherent without wrong-quadrant poses or reversals.

- [ ] **Step 6: Run final independent visual QA**

Review the standard and extended contact sheets, normal-size direction sheet, previews, semantic verdicts, blind validation, continuity report, structural validation, and despill report. Any major failure requires regenerating the entire containing look row.

- [ ] **Step 7: Make rollback copies and atomically install v2 files**

```powershell
$pet = 'C:\Users\Administrator\.codex\pets\aemeath-mini'
Copy-Item -LiteralPath "$pet\spritesheet.webp" -Destination "$pet\spritesheet-v1-backup-20260827.webp" -Force
Copy-Item -LiteralPath "$pet\pet.json" -Destination "$pet\pet-v1-backup-20260827.json" -Force
Copy-Item -LiteralPath "$run\final\spritesheet-extended.webp" -Destination "$pet\spritesheet.webp" -Force
@'
{
  "id": "aemeath-mini",
  "displayName": "Aemeath Mini",
  "description": "Q版像素爱弥斯桌宠 v5：保留原有动作并支持 16 个自然观看方向。",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
'@ | Set-Content -LiteralPath "$pet\pet.json" -Encoding utf8NoBOM
```

- [ ] **Step 8: Validate the installed package and record run summary**

```powershell
& $python "$skill\scripts\validate_atlas.py" "$pet\spritesheet.webp" --chroma-key '#00FF00' --require-v2
Get-Content -LiteralPath "$pet\pet.json" -Raw | ConvertFrom-Json | ConvertTo-Json
```

Expected: installed sprite validates as v2 and manifest contains `spriteVersionNumber: 2`.

- [ ] **Step 9: Rollback procedure for any failed final smoke check**

```powershell
Copy-Item -LiteralPath "$pet\spritesheet-v1-backup-20260827.webp" -Destination "$pet\spritesheet.webp" -Force
Copy-Item -LiteralPath "$pet\pet-v1-backup-20260827.json" -Destination "$pet\pet.json" -Force
```
