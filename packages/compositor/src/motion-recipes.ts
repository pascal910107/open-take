import { analyzeLaunchStory } from "./launch-story";
import type {
  LaunchComposition,
  LaunchIssue,
  LaunchScene,
  LaunchTheme,
  LaunchTransition,
} from "./launch-types";
import { validateLaunchComposition } from "./launch-validate";
import { motionGraphemes } from "./motion-evaluate";
import { analyzeMotionQuality, estimateMotionReadingSeconds } from "./motion-quality";
import type {
  MotionGroupLayer,
  MotionImageCrop,
  MotionLayer,
  MotionScene,
  MotionTextLayer,
} from "./motion-types";
import { estimateMotionTextLines } from "./motion-validate";

export type MotionRecipeImage = { asset: string; crop?: MotionImageCrop };
export type MotionRecipeStyle = "editorial" | "product" | "technical";
type RecipeBase = {
  id: string;
  title: string;
  style?: MotionRecipeStyle;
  durationS?: number;
  motion?: "on" | "off";
  transition?: LaunchTransition;
};
export type FocusMotionRecipe = RecipeBase & {
  recipe: "focus";
  image: MotionRecipeImage;
  body?: string;
};
export type CompareMotionRecipe = RecipeBase & {
  recipe: "compare";
  before: { label: string; image: MotionRecipeImage };
  after: { label: string; image: MotionRecipeImage };
  body?: string;
};
export type StepsMotionRecipe = RecipeBase & {
  recipe: "steps";
  steps: { label: string; body?: string }[];
};
export type MotionRecipe = FocusMotionRecipe | CompareMotionRecipe | StepsMotionRecipe;
export type MotionStoryBrief = Omit<LaunchComposition, "scenes"> & {
  scenes: (LaunchScene | MotionRecipe)[];
};
export type MotionStoryResult = { composition?: LaunchComposition; issues: LaunchIssue[] };
type Box = { x: number; y: number; width: number; height: number };
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const error = (path: string, message: string): LaunchIssue => ({
  severity: "error",
  path,
  message,
});

function parseRecipe(
  raw: Record<string, unknown>,
  path: string,
  issues: LaunchIssue[],
): MotionRecipe | undefined {
  const start = issues.length;
  const add = (p: string, message: string) => issues.push(error(p, message));
  const fields = (obj: Record<string, unknown>, keys: string[], p: string) => {
    for (const key of Object.keys(obj))
      if (!keys.includes(key)) add(`${p}.${key}`, "unsupported recipe field");
  };
  const text = (v: unknown, p: string, max: number) => {
    if (typeof v !== "string" || !v.trim() || motionGraphemes(v).length > max)
      add(
        p,
        `must be non-empty copy of at most ${max} graphemes; shorter copy may be required to fit the chosen layout`,
      );
  };
  const image = (v: unknown, p: string) => {
    if (!record(v)) {
      add(p, "must be an image object with a local asset path");
      return;
    }
    fields(v, ["asset", "crop"], p);
    if (
      typeof v.asset !== "string" ||
      !v.asset.trim() ||
      v.asset.length > 4096 ||
      v.asset.includes("\0") ||
      !/\.(png|jpe?g|webp)$/i.test(v.asset) ||
      (/^[a-z][a-z\d+.-]*:/i.test(v.asset) && !/^[a-z]:[\\/]/i.test(v.asset))
    )
      add(
        `${p}.asset`,
        "must be a local PNG/JPEG/WebP path; use the asset checker to verify the actual file",
      );
    if (v.crop !== undefined) {
      if (!record(v.crop)) add(`${p}.crop`, "must be an object");
      else {
        fields(v.crop, ["x", "y", "width", "height"], `${p}.crop`);
        for (const key of ["x", "y", "width", "height"])
          if (
            !finite(v.crop[key]) ||
            !Number.isInteger(v.crop[key]) ||
            v.crop[key] < (key === "x" || key === "y" ? 0 : 1) ||
            v.crop[key] > 32768
          )
            add(`${p}.crop.${key}`, "must be an integer source-pixel value in the supported range");
      }
    }
  };
  const common = ["id", "recipe", "title", "style", "durationS", "motion", "transition"];
  if (typeof raw.recipe !== "string" || !["focus", "compare", "steps"].includes(raw.recipe)) {
    add(`${path}.recipe`, "must be focus, compare, or steps");
    return;
  }
  fields(
    raw,
    [
      ...common,
      ...(raw.recipe === "focus"
        ? ["image", "body"]
        : raw.recipe === "compare"
          ? ["before", "after", "body"]
          : ["steps"]),
    ],
    path,
  );
  text(raw.id, `${path}.id`, 200);
  text(raw.title, `${path}.title`, 160);
  if (
    raw.style !== undefined &&
    raw.style !== "editorial" &&
    raw.style !== "product" &&
    raw.style !== "technical"
  )
    add(`${path}.style`, "must be editorial, product, or technical");
  if (
    raw.durationS !== undefined &&
    (!finite(raw.durationS) || raw.durationS <= 0 || raw.durationS > 86400)
  )
    add(`${path}.durationS`, "must be finite, positive and no more than 86400s");
  if (raw.motion !== undefined && raw.motion !== "on" && raw.motion !== "off")
    add(`${path}.motion`, "must be on or off");
  if (raw.transition !== undefined) {
    if (!record(raw.transition)) add(`${path}.transition`, "must be an object");
    else {
      fields(raw.transition, ["type", "durationS"], `${path}.transition`);
      if (
        typeof raw.transition.type !== "string" ||
        !["cut", "fade", "slide"].includes(raw.transition.type)
      )
        add(`${path}.transition.type`, "must be cut, fade, or slide");
      if (
        raw.transition.durationS !== undefined &&
        (!finite(raw.transition.durationS) || raw.transition.durationS <= 0)
      )
        add(`${path}.transition.durationS`, "must be finite and positive");
    }
  }
  if (raw.recipe === "focus") image(raw.image, `${path}.image`);
  if (raw.recipe === "focus" || raw.recipe === "compare")
    if (raw.body !== undefined) text(raw.body, `${path}.body`, 360);
  if (raw.recipe === "compare")
    for (const side of ["before", "after"]) {
      const item = raw[side];
      if (!record(item)) add(`${path}.${side}`, "must contain a label and image");
      else {
        fields(item, ["label", "image"], `${path}.${side}`);
        text(item.label, `${path}.${side}.label`, 80);
        image(item.image, `${path}.${side}.image`);
      }
    }
  if (raw.recipe === "steps") {
    if (!Array.isArray(raw.steps) || raw.steps.length < 2 || raw.steps.length > 5)
      add(`${path}.steps`, "must contain 2 to 5 steps");
    else
      raw.steps.forEach((step, i) => {
        const p = `${path}.steps[${i}]`;
        if (!record(step)) {
          add(p, "must contain a label and optional body");
          return;
        }
        fields(step, ["label", "body"], p);
        text(step.label, `${p}.label`, 80);
        if (step.body !== undefined) text(step.body, `${p}.body`, 200);
      });
  }
  return issues.length === start ? (raw as unknown as MotionRecipe) : undefined;
}

function buildRecipe(
  recipe: MotionRecipe,
  path: string,
  output: LaunchComposition["output"],
  theme: LaunchTheme,
  issues: LaunchIssue[],
): MotionScene {
  const W = output.width,
    H = output.height,
    S = Math.min(W, H),
    style = recipe.style,
    portrait =
      H > W ||
      (H === W &&
        (recipe.recipe === "focus" || (recipe.recipe === "steps" && recipe.steps.length <= 3))),
    margin =
      S *
      (style === "editorial"
        ? 0.085
        : style === "product"
          ? 0.05
          : style === "technical"
            ? 0.055
            : 0.07),
    gap =
      S *
      (style === "editorial"
        ? 0.055
        : style === "product"
          ? 0.032
          : style === "technical"
            ? 0.028
            : 0.045),
    pad =
      S *
      (style === "editorial"
        ? 0.01
        : style === "product"
          ? 0.007
          : style === "technical"
            ? 0.009
            : 0.012);
  const innerW = W - 2 * margin,
    innerH = H - 2 * margin,
    left = -W / 2 + margin,
    top = -H / 2 + margin;
  const fonts = {
    title: Math.min(
      512,
      Math.max(
        24,
        S *
          (style === "editorial"
            ? 0.072
            : style === "product"
              ? 0.056
              : style === "technical"
                ? 0.052
                : 0.06),
      ),
    ),
    label: Math.min(
      512,
      Math.max(
        14,
        S *
          (style === "editorial"
            ? 0.034
            : style === "product"
              ? 0.038
              : style === "technical"
                ? 0.031
                : 0.037),
      ),
    ),
    body: Math.min(
      512,
      Math.max(
        14,
        S *
          (style === "editorial"
            ? 0.027
            : style === "product"
              ? 0.029
              : style === "technical"
                ? 0.025
                : 0.03),
      ),
    ),
    number: Math.min(
      512,
      Math.max(
        14,
        S *
          (style === "editorial"
            ? 0.026
            : style === "product"
              ? 0.03
              : style === "technical"
                ? 0.024
                : 0.03),
      ),
    ),
  };
  const layers: MotionLayer[] = [],
    texts: string[] = [];
  let latestEntrance = 0;
  const text = (
    id: string,
    copy: string,
    box: Box,
    role: keyof typeof fonts,
    sourcePath: string,
    fill = theme.ink,
    padding = pad,
  ): MotionTextLayer => {
    const size = fonts[role],
      width = box.width - padding * 2,
      height = box.height - padding * 2,
      lineHeight = size * 1.28;
    if (
      width <= 0 ||
      height <= 0 ||
      estimateMotionTextLines(copy, width, size) * lineHeight > height + 0.001
    )
      issues.push(
        error(
          sourcePath,
          `copy does not fit the ${recipe.recipe} ${W === H ? "square" : portrait ? "portrait" : "landscape"} ${role} region; shorten it or use a custom motion scene with a larger text box`,
        ),
      );
    texts.push(copy);
    return {
      id,
      type: "text",
      text: copy,
      x: box.x,
      y: box.y,
      width: Math.max(0.001, width),
      height: Math.max(0.001, height),
      fontSize: size,
      lineHeight,
      fontFamily: theme.fontFamily,
      fontWeight:
        role === "title"
          ? style === "product"
            ? 700
            : style === "technical"
              ? 600
              : 650
          : role === "label"
            ? style === "technical"
              ? 550
              : 600
            : style === "editorial"
              ? 400
              : 450,
      fill,
      align: "left",
    };
  };
  const group = (id: string, children: MotionLayer[], delay: number): MotionGroupLayer => {
    const animated = recipe.motion !== "off" && id !== "heading" && id !== "message";
    const entranceS =
        style === "editorial"
          ? 0.68
          : style === "product"
            ? 0.62
            : style === "technical"
              ? 0.42
              : 0.55,
      finish = delay + entranceS;
    if (animated) latestEntrance = Math.max(latestEntrance, finish);
    const keyframes = (a: number, b: number) => [
      { atS: 0, value: a },
      ...(delay > 0 ? [{ atS: delay, value: a }] : []),
      { atS: finish, value: b, easing: "ease-out" as const },
    ];
    return {
      id,
      type: "group",
      children,
      ...(!animated
        ? {}
        : {
            animations: [
              { property: "opacity", keyframes: keyframes(0, 1) },
              ...(style === "technical"
                ? [{ property: "x" as const, keyframes: keyframes(-S * 0.018, 0) }]
                : [
                    {
                      property: "y" as const,
                      keyframes: keyframes(
                        S * (style === "editorial" ? 0.014 : style === "product" ? 0.018 : 0.024),
                        0,
                      ),
                    },
                  ]),
              ...(style === "product"
                ? [
                    { property: "scaleX" as const, keyframes: keyframes(0.965, 1) },
                    { property: "scaleY" as const, keyframes: keyframes(0.965, 1) },
                  ]
                : []),
            ],
          }),
    };
  };
  const rule = (id: string, points: [number, number][], delay = 0.08): MotionLayer => {
    const finish = delay + (style === "technical" ? 0.34 : 0.52),
      animated = recipe.motion !== "off";
    if (animated) latestEntrance = Math.max(latestEntrance, finish);
    return {
      id,
      type: "line",
      points,
      stroke: theme.accent,
      strokeWidth: Math.max(1, S * (style === "technical" ? 0.0015 : 0.001)),
      end: 1,
      ...(animated
        ? {
            animations: [
              {
                property: "end",
                keyframes: [
                  { atS: 0, value: 0 },
                  ...(delay > 0 ? [{ atS: delay, value: 0 }] : []),
                  { atS: finish, value: 1, easing: "ease-out" },
                ],
              },
            ],
          }
        : {}),
    };
  };
  const picturePad = style === "editorial" ? S * 0.022 : pad;
  const picture = (id: string, image: MotionRecipeImage, box: Box): MotionLayer[] => {
    const radius =
        S *
        (style === "editorial"
          ? 0
          : style === "product"
            ? 0.026
            : style === "technical"
              ? 0.003
              : 0.016),
      imageRadius =
        S *
        (style === "editorial"
          ? 0
          : style === "product"
            ? 0.021
            : style === "technical"
              ? 0.002
              : 0.008);
    return [
      {
        id: `${id}-surface`,
        type: "rect",
        ...box,
        fill: theme.surface,
        radius,
        ...(style === "product"
          ? {
              shadow: {
                color: "#00000024",
                blur: Math.min(256, S * 0.032),
                offsetY: Math.min(512, S * 0.011),
              },
            }
          : style === "technical"
            ? { stroke: theme.accent, strokeWidth: Math.max(1, S * 0.0015) }
            : {}),
      },
      {
        id,
        type: "image",
        ...box,
        width: box.width - 2 * picturePad,
        height: box.height - 2 * picturePad,
        asset: image.asset,
        ...(image.crop ? { crop: { ...image.crop } } : {}),
        fit: "contain",
        radius: imageRadius,
      },
    ];
  };
  const fittedFocusBox = (image: MotionRecipeImage, box: Box): Box => {
    if (!style || !image.crop) return box;
    const mediaAspect = image.crop.width / image.crop.height,
      availableWidth = Math.max(0.001, box.width - 2 * picturePad),
      availableHeight = Math.max(0.001, box.height - 2 * picturePad);
    if (availableWidth / availableHeight > mediaAspect) {
      const innerWidth = availableHeight * mediaAspect;
      return {
        ...box,
        width: innerWidth + 2 * picturePad,
        height: availableHeight + 2 * picturePad,
      };
    }
    const innerHeight = availableWidth / mediaAspect;
    return { ...box, width: availableWidth + 2 * picturePad, height: innerHeight + 2 * picturePad };
  };
  const stepSurface = (id: string, box: Box): MotionLayer | undefined => {
    if (style !== "product" && style !== "technical") return undefined;
    return {
      id: `${id}-surface`,
      type: "rect",
      ...box,
      fill: theme.surface,
      radius: style === "product" ? S * 0.02 : S * 0.002,
      ...(style === "product"
        ? {
            shadow: {
              color: "#0000001F",
              blur: Math.min(256, S * 0.022),
              offsetY: Math.min(512, S * 0.008),
            },
          }
        : { stroke: theme.accent, strokeWidth: Math.max(1, S * 0.0015) }),
    };
  };
  if (recipe.recipe === "focus") {
    if (!portrait) {
      const copyW =
          (innerW - gap) *
          (style === "editorial"
            ? 0.44
            : style === "product"
              ? 0.29
              : style === "technical"
                ? 0.34
                : 0.36),
        imageW = innerW - gap - copyW,
        titleH = S * (style === "editorial" ? 0.32 : style === "technical" ? 0.22 : 0.26),
        bodyH = recipe.body
          ? S * (style === "editorial" ? 0.27 : style === "technical" ? 0.25 : 0.31)
          : 0,
        total = titleH + (recipe.body ? gap + bodyH : 0),
        x = left + copyW / 2;
      const content = [
        text(
          "title",
          recipe.title,
          { x, y: -total / 2 + titleH / 2, width: copyW, height: titleH },
          "title",
          `${path}.title`,
        ),
      ];
      if (recipe.body)
        content.push(
          text(
            "body",
            recipe.body,
            { x, y: total / 2 - bodyH / 2, width: copyW, height: bodyH },
            "body",
            `${path}.body`,
          ),
        );
      const visualBox = fittedFocusBox(recipe.image, {
        x: left + copyW + gap + imageW / 2,
        y: 0,
        width: imageW,
        height: innerH,
      });
      layers.push(
        group("message", content, 0),
        ...(style === "editorial" || style === "technical"
          ? [
              rule(
                `${style}-divider`,
                [
                  [left + copyW + gap / 2, -innerH * 0.42],
                  [left + copyW + gap / 2, innerH * 0.42],
                ],
                0.06,
              ),
            ]
          : []),
        group("visual", picture("image", recipe.image, visualBox), 0.12),
      );
    } else {
      const titleH = S * (style === "editorial" ? 0.26 : style === "technical" ? 0.19 : 0.22),
        bodyH = recipe.body
          ? S * (style === "editorial" ? 0.2 : style === "technical" ? 0.21 : 0.24)
          : 0,
        imageH = innerH - titleH - bodyH - gap * (recipe.body ? 2 : 1),
        sourceAware = style !== undefined && recipe.image.crop !== undefined,
        fitted = fittedFocusBox(recipe.image, {
          x: 0,
          y: 0,
          width: innerW,
          height: imageH,
        }),
        stackH = titleH + gap + fitted.height + (recipe.body ? gap + bodyH : 0),
        stackTop = sourceAware ? -stackH / 2 : top,
        imageTop = stackTop + titleH + gap,
        bodyY = sourceAware
          ? imageTop + fitted.height + gap + bodyH / 2
          : H / 2 - margin - bodyH / 2;
      layers.push(
        group(
          "heading",
          [
            text(
              "title",
              recipe.title,
              { x: 0, y: stackTop + titleH / 2, width: innerW, height: titleH },
              "title",
              `${path}.title`,
            ),
          ],
          0,
        ),
      );
      if (style === "editorial" || style === "technical")
        layers.push(
          rule(
            `${style}-divider`,
            [
              [left, stackTop + titleH + gap * 0.38],
              [left + innerW, stackTop + titleH + gap * 0.38],
            ],
            0.06,
          ),
        );
      layers.push(
        group(
          "visual",
          picture("image", recipe.image, {
            ...fitted,
            y: imageTop + fitted.height / 2,
          }),
          0.12,
        ),
      );
      if (recipe.body)
        layers.push(
          group(
            "message",
            [
              text(
                "body",
                recipe.body,
                { x: 0, y: bodyY, width: innerW, height: bodyH },
                "body",
                `${path}.body`,
              ),
            ],
            0.2,
          ),
        );
    }
  } else if (recipe.recipe === "compare") {
    const titleH = S * (style === "editorial" ? 0.22 : style === "technical" ? 0.15 : 0.18),
      bodyH = recipe.body
        ? S * (style === "editorial" ? 0.11 : style === "technical" ? 0.1 : 0.13)
        : 0,
      headH = titleH + (recipe.body ? gap * 0.45 + bodyH : 0),
      contentTop = top + headH + gap,
      contentH = innerH - headH - gap,
      labelH = S * (style === "editorial" ? 0.09 : style === "technical" ? 0.075 : 0.11);
    const header = [
      text(
        "title",
        recipe.title,
        { x: 0, y: top + titleH / 2, width: innerW, height: titleH },
        "title",
        `${path}.title`,
      ),
    ];
    if (recipe.body)
      header.push(
        text(
          "body",
          recipe.body,
          { x: 0, y: top + titleH + gap * 0.45 + bodyH / 2, width: innerW, height: bodyH },
          "body",
          `${path}.body`,
        ),
      );
    layers.push(group("heading", header, 0));
    if (style === "editorial")
      layers.push(
        rule(
          "editorial-heading-rule",
          [
            [left, contentTop - gap * 0.48],
            [left + innerW, contentTop - gap * 0.48],
          ],
          0.06,
        ),
      );
    if (style === "technical" && !portrait)
      layers.push(
        rule(
          "technical-centerline",
          [
            [0, contentTop],
            [0, contentTop + contentH],
          ],
          0.08,
        ),
      );
    (["before", "after"] as const).forEach((side, i) => {
      const item = recipe[side],
        width = portrait ? innerW : (innerW - gap) / 2,
        height = portrait ? (contentH - gap) / 2 : contentH,
        x = portrait ? 0 : left + i * (width + gap) + width / 2,
        y = contentTop + (portrait ? i * (height + gap) : 0);
      const children: MotionLayer[] = [
        text(
          `${side}-label`,
          item.label,
          { x, y: y + labelH / 2, width, height: labelH },
          "label",
          `${path}.${side}.label`,
        ),
        ...picture(`${side}-image`, item.image, {
          x,
          y: y + labelH + gap * 0.35 + (height - labelH - gap * 0.35) / 2,
          width,
          height: height - labelH - gap * 0.35,
        }),
      ];
      layers.push(group(side, children, 0.15 + i * 0.12));
    });
  } else {
    const compactRows = W === H && recipe.steps.length >= 4,
      titleH = compactRows
        ? estimateMotionTextLines(recipe.title, innerW - 2 * pad, fonts.title) *
            fonts.title *
            1.28 +
          2 * pad
        : S * 0.21,
      headingGap = compactRows ? S * 0.025 : gap,
      contentTop = top + titleH + headingGap,
      contentH = innerH - titleH - headingGap,
      n = recipe.steps.length,
      stepGap = compactRows ? S * 0.01 : gap * 0.65,
      rowSteps = portrait || style === "technical";
    if (compactRows && contentH < stepGap * (n - 1) + n * (fonts.label * 1.28 + S * 0.006))
      issues.push(
        error(
          `${path}.title`,
          "title leaves too little room for the square step rows; shorten it or use a custom motion scene with more room",
        ),
      );
    layers.push(
      group(
        "heading",
        [
          text(
            "title",
            recipe.title,
            { x: 0, y: top + titleH / 2, width: innerW, height: titleH },
            "title",
            `${path}.title`,
          ),
        ],
        0,
      ),
    );
    if (style === "editorial")
      layers.push(
        rule(
          "editorial-heading-rule",
          [
            [left, contentTop - headingGap * 0.48],
            [left + innerW, contentTop - headingGap * 0.48],
          ],
          0.06,
        ),
      );
    recipe.steps.forEach((step, i) => {
      if (compactRows) {
        // Full-width copy prevents ordinary words from breaking across narrow columns.
        // Smaller inner padding preserves the 14px floor even in a 320px square.
        const rowH = (contentH - stepGap * (n - 1)) / n,
          rowY = contentTop + i * (rowH + stepGap),
          inset = S * 0.003,
          numberW = Math.max(S * 0.06, fonts.number * 1.4 + 2 * inset),
          copyX = left + numberW + S * 0.018,
          copyW = innerW - numberW - S * 0.018,
          labelH =
            estimateMotionTextLines(step.label, copyW - 2 * inset, fonts.label) *
              fonts.label *
              1.28 +
            2 * inset,
          bodyGap = S * 0.005,
          bodyH = rowH - labelH - bodyGap;
        if (labelH > rowH + 0.001) {
          issues.push(
            error(
              `${path}.steps[${i}].label`,
              "copy does not fit its square step row; shorten the label or use a custom motion scene with a taller row",
            ),
          );
          return;
        }
        const children: MotionLayer[] = [
          text(
            `step-${i + 1}-number`,
            String(i + 1).padStart(2, "0"),
            { x: left + numberW / 2, y: rowY + labelH / 2, width: numberW, height: labelH },
            "number",
            `${path}.steps[${i}].label`,
            theme.accent,
            inset,
          ),
          text(
            `step-${i + 1}-label`,
            step.label,
            { x: copyX + copyW / 2, y: rowY + labelH / 2, width: copyW, height: labelH },
            "label",
            `${path}.steps[${i}].label`,
            theme.ink,
            inset,
          ),
        ];
        const surface = stepSurface(`step-${i + 1}`, {
          x: 0,
          y: rowY + rowH / 2,
          width: innerW,
          height: rowH,
        });
        if (surface) children.unshift(surface);
        if (style === "editorial")
          children.unshift(
            rule(
              `step-${i + 1}-rule`,
              [
                [left, rowY],
                [left + innerW, rowY],
              ],
              0.08 + i * 0.1,
            ),
          );
        if (step.body)
          children.push(
            text(
              `step-${i + 1}-body`,
              step.body,
              {
                x: copyX + copyW / 2,
                y: rowY + labelH + bodyGap + bodyH / 2,
                width: copyW,
                height: bodyH,
              },
              "body",
              `${path}.steps[${i}].body`,
              theme.ink,
              inset,
            ),
          );
        layers.push(group(`step-${i + 1}`, children, 0.12 * (i + 1)));
        return;
      }
      const width = rowSteps ? innerW : (innerW - stepGap * (n - 1)) / n,
        height = rowSteps ? (contentH - stepGap * (n - 1)) / n : contentH,
        x = rowSteps ? left : left + i * (width + stepGap),
        y = contentTop + (rowSteps ? i * (height + stepGap) : 0),
        numberW = Math.max(S * 0.08, fonts.number * 1.4 + 2 * pad),
        numberH = Math.max(S * 0.07, fonts.number * 1.28 + 2 * pad);
      const labelH =
          style === "editorial"
            ? Math.min(S * 0.11, height * 0.4)
            : Math.min(S * 0.13, height * 0.42),
        bodyH = height - (rowSteps ? labelH + pad : labelH + S * 0.09 + gap * 0.5),
        copyX = rowSteps ? x + numberW + pad : x,
        copyW = rowSteps ? width - numberW - pad : width;
      const children: MotionLayer[] = [
        text(
          `step-${i + 1}-number`,
          String(i + 1).padStart(2, "0"),
          { x: x + numberW / 2, y: y + numberH / 2, width: numberW, height: numberH },
          "number",
          `${path}.steps[${i}].label`,
          theme.accent,
        ),
        text(
          `step-${i + 1}-label`,
          step.label,
          {
            x: copyX + copyW / 2,
            y: y + (rowSteps ? 0 : S * 0.09) + labelH / 2,
            width: copyW,
            height: labelH,
          },
          "label",
          `${path}.steps[${i}].label`,
        ),
      ];
      const surface = stepSurface(`step-${i + 1}`, {
        x: x + width / 2,
        y: y + height / 2,
        width,
        height,
      });
      if (surface) children.unshift(surface);
      if (style === "editorial")
        children.unshift(
          rule(
            `step-${i + 1}-rule`,
            [
              [x, y],
              [x + width, y],
            ],
            0.08 + i * 0.1,
          ),
        );
      if (step.body)
        children.push(
          text(
            `step-${i + 1}-body`,
            step.body,
            { x: copyX + copyW / 2, y: y + height - bodyH / 2, width: copyW, height: bodyH },
            "body",
            `${path}.steps[${i}].body`,
          ),
        );
      layers.push(group(`step-${i + 1}`, children, 0.12 * (i + 1)));
    });
  }
  const transition = recipe.transition ?? { type: "cut" };
  const exit =
    recipe.motion === "off" || transition.type === "cut" ? 0 : (transition.durationS ?? 0.45);
  const reading = Math.max(
    1.2,
    texts.reduce((sum, value) => sum + estimateMotionReadingSeconds(value, 0), 0) + 0.4,
  );
  const minimum = (recipe.motion === "off" ? 0 : Math.max(latestEntrance, exit)) + reading + exit;
  const derived = Math.ceil(minimum * output.fps - 1e-8) / output.fps;
  const durationS = recipe.durationS ?? derived;
  if (recipe.durationS !== undefined && durationS + 0.001 < minimum)
    issues.push(
      error(
        `${path}.durationS`,
        `too short for this copy and motion; allow at least ${derived.toFixed(3)}s, shorten the copy, or disable motion`,
      ),
    );
  return {
    id: recipe.id,
    type: "motion",
    durationS,
    designSize: { width: W, height: H },
    motion: recipe.motion ?? "on",
    transition,
    layers,
  };
}

/** Expand guided recipes into ordinary editable layers. No asset I/O, capture or rendering. */
export function composeMotionStory(value: unknown): MotionStoryResult {
  const issues: LaunchIssue[] = [];
  if (!record(value)) return { issues: [error("$", "must be a motion story JSON object")] };
  for (const key of Object.keys(value))
    if (!["version", "output", "theme", "scenes", "audio", "story"].includes(key))
      issues.push(error(key, "unsupported motion story field"));
  issues.push(
    ...validateLaunchComposition({
      version: value.version,
      output: value.output,
      theme: value.theme,
      scenes: [
        { id: "header-check", type: "title", durationS: 1, lines: ["Check"], motion: "off" },
      ],
    }),
  );
  if (!Array.isArray(value.scenes) || !value.scenes.length)
    issues.push(error("scenes", "must contain at least one scene or recipe"));
  if (issues.length) return { issues };
  const output = value.output as LaunchComposition["output"],
    theme = value.theme as LaunchTheme;
  const generated = new Set<number>();
  const scenes = (value.scenes as unknown[]).map((raw, i) => {
    if (!record(raw) || !Object.hasOwn(raw, "recipe")) return raw;
    generated.add(i);
    const path = `scenes[${i}]`,
      recipe = parseRecipe(raw, path, issues);
    if (!recipe) return raw;
    if (Math.min(output.width, output.height) < 320) {
      issues.push(
        error(
          "output",
          "guided recipes require a short edge of at least 320px; use a custom motion scene for smaller output",
        ),
      );
      return raw;
    }
    return buildRecipe(recipe, path, output, theme, issues);
  });
  if (issues.some((x) => x.severity === "error")) return { issues };
  const candidate = {
    version: value.version,
    output,
    theme,
    scenes,
    ...(value.audio !== undefined ? { audio: value.audio } : {}),
    ...(value.story !== undefined ? { story: value.story } : {}),
  };
  issues.push(...validateLaunchComposition(candidate));
  if (issues.some((x) => x.severity === "error")) return { issues };
  let composition: LaunchComposition;
  try {
    composition = structuredClone(candidate) as LaunchComposition;
  } catch {
    return { issues: [error("$", "must contain only JSON-compatible data")] };
  }
  for (const finding of analyzeMotionQuality(composition)) {
    const sceneIndex = Number(finding.path.match(/^scenes\[(\d+)\]/)?.[1]);
    const provable =
      generated.has(sceneIndex) &&
      (finding.message.startsWith("Resting bounds") ||
        finding.message.startsWith("Text contrast") ||
        finding.message.startsWith("Text is small"));
    if (provable) {
      const contrast = finding.message.startsWith("Text contrast");
      const recipe = (value.scenes as Record<string, unknown>[])[sceneIndex]?.recipe;
      issues.push({
        ...finding,
        severity: "error",
        path: contrast ? "theme" : `scenes[${sceneIndex}]`,
        message: `${finding.message} In ${recipe} recipe scenes[${sceneIndex}], ${contrast ? "adjust brief theme.ink, theme.canvas, theme.surface or theme.accent to improve contrast" : "adjust the brief copy or output dimensions"}.`,
      });
    } else issues.push(finding);
  }
  issues.push(...analyzeLaunchStory(composition));
  return issues.some((x) => x.severity === "error") ? { issues } : { composition, issues };
}
