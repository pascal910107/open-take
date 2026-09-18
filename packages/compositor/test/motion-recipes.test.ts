import assert from "node:assert/strict";
import test from "node:test";
import { launchTemplate } from "../src/launch-template";
import type { LaunchComposition } from "../src/launch-types";
import { validateLaunchComposition } from "../src/launch-validate";
import { evaluateMotionScene, walkMotionLayers } from "../src/motion-evaluate";
import { analyzeMotionQuality, estimateMotionReadingSeconds } from "../src/motion-quality";
import {
  composeMotionStory,
  type MotionRecipe,
  type MotionRecipeStyle,
} from "../src/motion-recipes";
import type { MotionLayer, MotionScene } from "../src/motion-types";

const recipes: MotionRecipe[] = [
  {
    id: "focus",
    recipe: "focus",
    title: "See the result.",
    body: "A real screenshot keeps the story grounded.",
    image: { asset: "assets/result.png", crop: { x: 10, y: 20, width: 300, height: 200 } },
  },
  {
    id: "compare",
    recipe: "compare",
    title: "A clearer comparison.",
    before: { label: "Before", image: { asset: "before.jpg" } },
    after: { label: "After", image: { asset: "after.webp" } },
    body: "The same information, easier to use.",
  },
  {
    id: "steps",
    recipe: "steps",
    title: "From idea to release.",
    steps: [
      { label: "Capture", body: "Record the real product." },
      { label: "Compose", body: "Choose the useful details." },
      { label: "Refine", body: "Keep the result editable." },
    ],
  },
];
const brief = (recipe: MotionRecipe, portrait = false) => ({
  version: 1,
  output: { width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080, fps: 30 },
  theme: launchTemplate().theme,
  scenes: [recipe],
});
function requireScene(result: ReturnType<typeof composeMotionStory>): MotionScene {
  assert(result.composition, JSON.stringify(result.issues));
  const scene = result.composition.scenes[0]!;
  assert.equal(scene.type, "motion");
  return scene as MotionScene;
}

for (const recipe of recipes)
  for (const portrait of [false, true])
    test(`${recipe.recipe} recipe produces valid ${portrait ? "portrait" : "landscape"} editable geometry`, () => {
      const input = brief(recipe, portrait),
        snapshot = structuredClone(input),
        result = composeMotionStory(input),
        scene = requireScene(result);
      assert.deepEqual(input, snapshot);
      assert.deepEqual(
        scene.designSize,
        input.output.width === 1080 ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 },
      );
      assert.deepEqual(validateLaunchComposition(result.composition), []);
      assert.deepEqual(result.issues, []);
      const layers = walkMotionLayers(scene.layers),
        images = layers.filter((x) => x.type === "image");
      assert(images.every((x) => x.fit === "contain"));
      assert.equal(
        images.length,
        recipe.recipe === "focus" ? 1 : recipe.recipe === "compare" ? 2 : 0,
      );
      assert(scene.durationS > 2);
      assert(Math.abs(scene.durationS * 30 - Math.round(scene.durationS * 30)) < 1e-8);
      if (recipe.recipe === "focus") assert.deepEqual(images[0]!.crop, recipe.image.crop);
    });

test("layouts change structure across aspect ratios without changing copy", () => {
  const landscape = requireScene(composeMotionStory(brief(recipes[1]!))),
    portrait = requireScene(composeMotionStory(brief(recipes[1]!, true)));
  const images = (s: MotionScene) => walkMotionLayers(s.layers).filter((x) => x.type === "image");
  const a = images(landscape),
    b = images(portrait);
  assert.notEqual(a[0]!.x, a[1]!.x);
  assert.equal(a[0]!.y, a[1]!.y);
  assert.equal(b[0]!.x, b[1]!.x);
  assert.notEqual(b[0]!.y, b[1]!.y);
});

test("square output stacks focus and steps while keeping comparison columns", () => {
  for (const size of [640, 1080])
    for (const recipe of recipes) {
      const copy =
        recipe.recipe === "focus"
          ? {
              ...recipe,
              title: "Every handoff has an owner.",
              body: "Show the verified result, then explain its value.",
            }
          : recipe;
      const input = brief(copy);
      input.output = { width: size, height: size, fps: 30 };
      const result = composeMotionStory(input);
      const scene = requireScene(result);
      assert.deepEqual(result.issues, []);
      const layers = walkMotionLayers(scene.layers);
      if (recipe.recipe === "focus") {
        const title = layers.find((layer) => layer.id === "title")!;
        const image = layers.find((layer) => layer.type === "image")!;
        assert.equal(title.x, image.x);
        assert((title.y ?? 0) < (image.y ?? 0));
      } else if (recipe.recipe === "steps") {
        const labels = layers.filter((layer) => layer.id.endsWith("-label"));
        assert.equal(labels[0]!.x, labels[1]!.x);
        assert((labels[0]!.y ?? 0) < (labels[1]!.y ?? 0));
      } else {
        const images = layers.filter((layer) => layer.type === "image");
        assert.notEqual(images[0]!.x, images[1]!.x);
        assert.equal(images[0]!.y, images[1]!.y);
      }
    }
});

test("duration follows readable content, honors explicit values and rejects too-short scenes", () => {
  const recipe = recipes[0]! as Extract<MotionRecipe, { recipe: "focus" }>;
  const short = requireScene(composeMotionStory(brief({ ...recipe, body: "A result." })));
  const longer = requireScene(
    composeMotionStory(
      brief({ ...recipe, body: "A useful result, with the important details still visible." }),
    ),
  );
  assert(longer.durationS > short.durationS);
  assert.equal(
    requireScene(composeMotionStory(brief({ ...recipe, durationS: 20.125 }))).durationS,
    20.125,
  );
  const bad = composeMotionStory(brief({ ...recipe, durationS: 0.2 }));
  assert.equal(bad.composition, undefined);
  assert(
    bad.issues.some((x) => x.path === "scenes[0].durationS" && x.message.includes("too short")),
  );
});

test("square four/five-step stories give ordinary labels one full line, including at 320px", () => {
  for (const size of [320, 640, 1080])
    for (const count of [4, 5]) {
      const recipe: MotionRecipe = {
        id: "steps",
        recipe: "steps",
        title: size === 320 ? "Clear steps" : "From a real interaction to a clear story.",
        steps: ["Capture", "Compose", "Refine", "Review", "Deliver"]
          .slice(0, count)
          .map((label) => ({ label, body: "Keep the result editable." })),
      };
      const input = brief(recipe);
      input.output = { width: size, height: size, fps: 30 };
      const result = composeMotionStory(input);
      const scene = requireScene(result);
      assert.deepEqual(result.issues, []);
      const all = walkMotionLayers(scene.layers);
      const labels = all.filter((layer) => layer.type === "text" && layer.id.endsWith("-label"));
      const bodies = all.filter((layer) => layer.type === "text" && layer.id.endsWith("-body"));
      assert.equal(labels.length, count);
      assert.equal(bodies.length, count);
      for (let i = 0; i < count; i++) {
        const label = labels[i]!;
        const body = bodies[i]!;
        assert.equal(label.text, recipe.steps[i]!.label);
        assert.equal(body.text, recipe.steps[i]!.body);
        // A conservative per-letter advance proves these ordinary labels need no wrapping.
        assert(label.width >= label.text.length * label.fontSize * 0.75);
        assert(label.fontSize >= 14 && body.fontSize >= 14);
        assert.equal(label.x, body.x);
        assert((label.y ?? 0) + label.height / 2 < (body.y ?? 0) - body.height / 2);
        assert(Math.abs(body.x ?? 0) + body.width / 2 < size / 2);
        assert(Math.abs(body.y ?? 0) + body.height / 2 < size / 2);
        if (i > 0) {
          const previous = bodies[i - 1]!;
          assert.equal(label.x, labels[i - 1]!.x);
          assert((previous.y ?? 0) + previous.height / 2 < (label.y ?? 0) - label.height / 2);
        }
      }
      const first = evaluateMotionScene(scene, 0).layers.find((layer) => layer.id === "heading");
      assert(
        first?.type === "group" &&
          first.opacity === 1 &&
          first.children[0]?.type === "text" &&
          first.children[0].text === recipe.title,
      );
      const off = requireScene(
        composeMotionStory({ ...input, scenes: [{ ...recipe, motion: "off" }] }),
      );
      assert(walkMotionLayers(off.layers).every((layer) => !layer.animations?.length));
    }
});

test("derived duration includes a long explicit transition before the useful reading hold", () => {
  const recipe = {
    ...recipes[0]!,
    title: "Choose well.",
    body: "Compare useful results and keep the important details visible.",
    transition: { type: "fade" as const, durationS: 3 },
  };
  const result = composeMotionStory(brief(recipe));
  const scene = requireScene(result);
  assert.deepEqual(result.issues, []);
  assert(scene.durationS >= 6 + estimateMotionReadingSeconds(recipe.body));
});

test("square rows reject overflowing labels without bodies at the original brief field", () => {
  const recipe: MotionRecipe = {
    id: "rows",
    recipe: "steps",
    title: "Clear steps",
    steps: ["Capture", "Compose", "Refine", "Review", "Deliver"].map((label) => ({ label })),
  };
  for (const size of [320, 640, 1080])
    for (const count of [4, 5]) {
      const input = {
        ...brief(recipe),
        output: { width: size, height: size, fps: 30 },
        scenes: [{ ...recipe, steps: recipe.steps.slice(0, count) }],
      };
      const result = composeMotionStory(input);
      const scene = requireScene(result);
      assert.deepEqual(result.issues, []);
      assert.equal(
        walkMotionLayers(scene.layers).filter((layer) => layer.id.endsWith("-label")).length,
        count,
      );
    }
  const input = { ...brief(recipe), output: { width: 320, height: 320, fps: 30 } };
  const longLabel = "Capture every useful detail and preserve the complete story for later review";
  const bad = composeMotionStory({
    ...input,
    scenes: [
      { ...recipe, steps: recipe.steps.map((step, i) => (i === 1 ? { label: longLabel } : step)) },
    ],
  });
  assert.equal(bad.composition, undefined);
  assert(
    bad.issues.some(
      (issue) =>
        issue.path === "scenes[0].steps[1].label" && issue.message.includes("square step row"),
    ),
  );
  const tallTitle = composeMotionStory({
    ...input,
    scenes: [
      {
        ...recipe,
        title:
          "A useful title that explains every detail of the complete process and leaves no useful space for the important step labels below",
      },
    ],
  });
  assert.equal(tallTitle.composition, undefined);
  assert(
    tallTitle.issues.some(
      (issue) => issue.path === "scenes[0].title" && issue.message.includes("square step rows"),
    ),
  );
});

test("motion off keeps complete resting copy and omits entrance tracks", () => {
  const scene = requireScene(composeMotionStory(brief({ ...recipes[2]!, motion: "off" })));
  assert.equal(scene.motion, "off");
  assert(walkMotionLayers(scene.layers).every((x) => !x.animations?.length));
  const evaluated = evaluateMotionScene(scene, 0);
  const visit = (layers: typeof evaluated.layers): string[] =>
    layers.flatMap((x) =>
      x.type === "text" ? [x.text] : x.type === "group" ? visit(x.children) : [],
    );
  assert(visit(evaluated.layers).includes("From idea to release."));
});

test("default recipes expose their primary message at frame zero through visible ancestors", () => {
  for (const recipe of recipes)
    for (const portrait of [false, true]) {
      const scene = requireScene(composeMotionStory(brief(recipe, portrait)));
      assert.equal(scene.transition?.type, "cut");
      const evaluated = evaluateMotionScene(scene, 0);
      const visibleText = (layers: typeof evaluated.layers, opacity = 1): string[] =>
        layers.flatMap((layer) => {
          const visible = opacity * layer.opacity;
          return layer.type === "group"
            ? visibleText(layer.children, visible)
            : layer.type === "text" && visible >= 0.99
              ? [layer.text]
              : [];
        });
      assert(visibleText(evaluated.layers).includes(recipe.title));
    }
  const transition = { type: "fade" as const, durationS: 0.4 };
  assert.deepEqual(
    requireScene(composeMotionStory(brief({ ...recipes[0]!, transition }))).transition,
    transition,
  );
});

const styles: MotionRecipeStyle[] = ["editorial", "product", "technical"];
const authoredCopy = (recipe: MotionRecipe): string[] => {
  if (recipe.recipe === "focus") return [recipe.title, ...(recipe.body ? [recipe.body] : [])];
  if (recipe.recipe === "compare")
    return [
      recipe.title,
      ...(recipe.body ? [recipe.body] : []),
      recipe.before.label,
      recipe.after.label,
    ];
  return [
    recipe.title,
    ...recipe.steps.flatMap((step) => [step.label, ...(step.body ? [step.body] : [])]),
  ];
};

for (const style of styles)
  for (const recipe of recipes)
    for (const aspect of ["landscape", "portrait", "square"] as const)
      test(`${style} ${recipe.recipe} treatment is valid and readable in ${aspect}`, () => {
        const styled = { ...structuredClone(recipe), style } as MotionRecipe;
        const input = brief(styled, aspect === "portrait");
        if (aspect === "square") input.output = { width: 1080, height: 1080, fps: 30 };
        const snapshot = structuredClone(input),
          result = composeMotionStory(input),
          scene = requireScene(result),
          layers = walkMotionLayers(scene.layers),
          renderedCopy = layers
            .filter(
              (layer): layer is Extract<MotionLayer, { type: "text" }> => layer.type === "text",
            )
            .map((layer) => layer.text);
        assert.deepEqual(input, snapshot);
        assert.deepEqual(validateLaunchComposition(result.composition), []);
        assert.deepEqual(result.issues, []);
        for (const copy of authoredCopy(styled)) assert(renderedCopy.includes(copy), copy);
        assert(
          layers.filter((layer) => layer.type === "text").every((layer) => layer.fontSize >= 14),
        );
        if (style === "editorial") {
          assert(layers.some((layer) => layer.type === "line"));
          if (recipe.recipe !== "steps")
            assert(
              layers.some(
                (layer) =>
                  layer.type === "rect" && layer.id.endsWith("-surface") && layer.radius === 0,
              ),
            );
        }
        if (style === "product") {
          assert(
            layers.some(
              (layer) =>
                layer.type === "rect" &&
                layer.id.endsWith("-surface") &&
                layer.shadow !== undefined,
            ),
          );
          assert(
            walkMotionLayers(scene.layers).some((layer) =>
              layer.animations?.some((track) => track.property === "scaleX"),
            ),
          );
          assert(
            layers
              .filter((layer) => layer.type === "image")
              .every((layer) => layer.fit === "contain"),
          );
        }
        if (style === "technical") {
          assert(
            layers.some(
              (layer) =>
                layer.type === "rect" &&
                layer.id.endsWith("-surface") &&
                layer.strokeWidth !== undefined &&
                layer.strokeWidth > 0,
            ),
          );
          assert(
            walkMotionLayers(scene.layers).some((layer) =>
              layer.animations?.some((track) => track.property === "x"),
            ),
          );
          if (recipe.recipe === "steps" && aspect === "landscape") {
            const labels = layers.filter((layer) => layer.id.endsWith("-label"));
            assert(labels.every((layer) => layer.x === labels[0]!.x));
          }
        }
      });

test("styled recipes keep all content static and complete when motion is off", () => {
  for (const style of styles)
    for (const recipe of recipes) {
      const styled = { ...structuredClone(recipe), style, motion: "off" as const } as MotionRecipe;
      const input = brief(styled);
      input.output = { width: 1080, height: 1080, fps: 30 };
      const scene = requireScene(composeMotionStory(input));
      assert(walkMotionLayers(scene.layers).every((layer) => !layer.animations?.length));
      const evaluated = evaluateMotionScene(scene, 0),
        allText = walkMotionLayers(evaluated.layers).flatMap((layer) =>
          layer.type === "text" ? [layer.text] : [],
        );
      for (const copy of authoredCopy(styled)) assert(allText.includes(copy), copy);
    }
});

test("styled focus uses authored crop aspect and keeps portrait support copy with the media", () => {
  const base = recipes[0]! as Extract<MotionRecipe, { recipe: "focus" }>,
    aspect = base.image.crop!.width / base.image.crop!.height;
  for (const style of styles)
    for (const portrait of [false, true]) {
      const result = composeMotionStory(brief({ ...base, style }, portrait)),
        scene = requireScene(result),
        layers = walkMotionLayers(scene.layers),
        surface = layers.find(
          (layer): layer is Extract<MotionLayer, { type: "rect" }> =>
            layer.type === "rect" && layer.id === "image-surface",
        )!,
        image = layers.find(
          (layer): layer is Extract<MotionLayer, { type: "image" }> =>
            layer.type === "image" && layer.id === "image",
        )!,
        inset = 1080 * (style === "editorial" ? 0.022 : style === "product" ? 0.007 : 0.009);
      assert(Math.abs(image.width / image.height - aspect) < 1e-8);
      assert(Math.abs(surface.width - image.width - 2 * inset) < 1e-8);
      assert(Math.abs(surface.height - image.height - 2 * inset) < 1e-8);
      assert.equal(image.fit, "contain");
      assert.deepEqual(image.crop, base.image.crop);
      if (portrait) {
        const title = layers.find((layer) => layer.id === "title")!,
          body = layers.find((layer) => layer.id === "body")!;
        assert((title.y ?? 0) + title.height / 2 < (surface.y ?? 0) - surface.height / 2);
        assert((surface.y ?? 0) + surface.height / 2 < (body.y ?? 0) - body.height / 2);
      }
    }
});

test("styled focus fits extreme crop aspects inside positive padded media bounds", () => {
  for (const style of styles)
    for (const portrait of [false, true])
      for (const [width, height] of [
        [10000, 100],
        [100, 10000],
      ]) {
        const recipe: MotionRecipe = {
          id: `extreme-${style}-${portrait}-${width}`,
          recipe: "focus",
          style,
          title: "A clear result.",
          body: "Keep the source intact.",
          image: { asset: "extreme.png", crop: { x: 0, y: 0, width, height } },
        };
        const result = composeMotionStory(brief(recipe, portrait)),
          scene = requireScene(result),
          layers = walkMotionLayers(scene.layers),
          surface = layers.find(
            (layer): layer is Extract<MotionLayer, { type: "rect" }> =>
              layer.type === "rect" && layer.id === "image-surface",
          )!,
          image = layers.find(
            (layer): layer is Extract<MotionLayer, { type: "image" }> =>
              layer.type === "image" && layer.id === "image",
          )!;
        assert.deepEqual(result.issues, []);
        assert(image.width > 0 && image.height > 0);
        assert(surface.width > image.width && surface.height > image.height);
        assert(Math.abs(image.width / image.height - width / height) < 1e-8);
        assert.deepEqual(validateLaunchComposition(result.composition), []);
      }
});

test("unstyled focus retains its original full-region geometry with crop metadata", () => {
  const base = recipes[0]! as Extract<MotionRecipe, { recipe: "focus" }>,
    landscape = requireScene(composeMotionStory(brief(base))),
    portrait = requireScene(composeMotionStory(brief(base, true))),
    surface = (scene: MotionScene) =>
      walkMotionLayers(scene.layers).find(
        (layer): layer is Extract<MotionLayer, { type: "rect" }> =>
          layer.type === "rect" && layer.id === "image-surface",
      )!;
  assert(Math.abs(surface(landscape).height - (1080 - 2 * 1080 * 0.07)) < 1e-8);
  const portraitInnerH = 1920 - 2 * 1080 * 0.07,
    titleH = 1080 * 0.22,
    bodyH = 1080 * 0.24,
    gap = 1080 * 0.045;
  assert(Math.abs(surface(portrait).height - (portraitInnerH - titleH - bodyH - 2 * gap)) < 1e-8);
});

test("mixed Latin and CJK matrix copy fits every style and aspect", () => {
  const matrixRecipes = (style: MotionRecipeStyle): MotionRecipe[] => [
    {
      id: `${style}-focus`,
      recipe: "focus",
      style,
      title: "One signal, clearly framed.",
      body: "保留真實畫面，讓成果一眼可讀。",
      image: { asset: "analytics.png", crop: { x: 64, y: 484, width: 1312, height: 301 } },
    },
    {
      id: `${style}-compare`,
      recipe: "compare",
      style,
      title: "Two designs. One decision.",
      body: "並列兩款設計，清楚比較差異。",
      before: { label: "Terra", image: { asset: "before.png" } },
      after: { label: "Orb", image: { asset: "after.png" } },
    },
    {
      id: `${style}-steps`,
      recipe: "steps",
      style,
      title: "From capture to release.",
      steps: [
        { label: "Capture", body: "保存真實操作。" },
        { label: "Compose", body: "整理清楚重點。" },
        { label: "Deliver", body: "輸出可讀成果。" },
      ],
    },
  ];
  for (const style of styles)
    for (const output of [
      { width: 1920, height: 1080, fps: 30 },
      { width: 1080, height: 1920, fps: 30 },
      { width: 1080, height: 1080, fps: 30 },
    ]) {
      const result = composeMotionStory({
        version: 1,
        output,
        theme: launchTemplate().theme,
        scenes: matrixRecipes(style),
      });
      assert(result.composition, JSON.stringify(result.issues));
      assert.deepEqual(result.issues, []);
    }
});

test("unsupported recipe styles fail at the authored field", () => {
  const bad = composeMotionStory(
    brief({ ...recipes[0]!, style: "cinematic" as MotionRecipeStyle }),
  );
  assert.equal(bad.composition, undefined);
  assert(
    bad.issues.some(
      (issue) =>
        issue.path === "scenes[0].style" &&
        issue.message === "must be editorial, product, or technical",
    ),
  );
});

test("320px short-edge recipes keep readable fonts and valid padded geometry", () => {
  const small: MotionRecipe[] = [
    {
      id: "f",
      recipe: "focus",
      title: "A result",
      body: "Keep useful details.",
      image: { asset: "a.png" },
    },
    {
      id: "c",
      recipe: "compare",
      title: "A change",
      before: { label: "Before", image: { asset: "a.png" } },
      after: { label: "After", image: { asset: "b.png" } },
    },
    {
      id: "s",
      recipe: "steps",
      title: "Three steps",
      steps: [
        { label: "Capture", body: "Real work." },
        { label: "Compose", body: "Clear copy." },
        { label: "Refine", body: "Good details." },
      ],
    },
  ];
  for (const recipe of small)
    for (const portrait of [false, true]) {
      const input = brief(recipe, portrait);
      input.output = { width: portrait ? 320 : 568, height: portrait ? 568 : 320, fps: 30 };
      const result = composeMotionStory(input);
      const scene = requireScene(result);
      assert.deepEqual(result.issues, []);
      assert.deepEqual(validateLaunchComposition(result.composition), []);
      for (const layer of walkMotionLayers(scene.layers)) {
        if (layer.type === "text") assert(layer.fontSize >= 14);
        if ("width" in layer && layer.width !== undefined)
          assert(Math.abs(layer.x ?? 0) + layer.width / 2 < input.output.width / 2);
        if ("height" in layer && layer.height !== undefined)
          assert(Math.abs(layer.y ?? 0) + layer.height / 2 < input.output.height / 2);
      }
    }
});

test("CJK reading estimates require more hold than equal-length ASCII word copy", () => {
  const latin = "See all the useful work.";
  const chinese = "看見真正的成果保留重要細節讓每個改變清楚呈現眼前";
  assert.equal([...latin].length, [...chinese].length);
  assert(estimateMotionReadingSeconds(chinese) > estimateMotionReadingSeconds(latin));
  const base = recipes[0]! as Extract<MotionRecipe, { recipe: "focus" }>;
  const englishScene = requireScene(composeMotionStory(brief({ ...base, body: latin })));
  const chineseScene = requireScene(composeMotionStory(brief({ ...base, body: chinese })));
  assert(chineseScene.durationS > englishScene.durationS);
  const short = composeMotionStory(
    brief({ ...base, body: chinese, durationS: englishScene.durationS }),
  );
  assert(
    short.issues.some(
      (issue) => issue.path === "scenes[0].durationS" && issue.severity === "error",
    ),
  );
  assert(
    analyzeMotionQuality(quality([text({ text: chinese })], 3)).some((issue) =>
      issue.message.includes("fully revealed hold"),
    ),
  );
  assert(
    !analyzeMotionQuality(quality([text({ text: latin })], 3)).some((issue) =>
      issue.message.includes("fully revealed hold"),
    ),
  );
});

test("Unicode survives composition and long copy fails at its authored field", () => {
  const recipe: MotionRecipe = {
    id: "unicode",
    recipe: "focus",
    title: "看見真正的成果",
    body: "保留細節，讓改變更清楚。👨‍👩‍👧‍👦",
    image: { asset: "實際畫面.png" },
  };
  const scene = requireScene(composeMotionStory(brief(recipe, true)));
  assert(walkMotionLayers(scene.layers).some((x) => x.type === "text" && x.text === recipe.body));
  const bad = composeMotionStory(brief({ ...recipe, title: "過長的標題文字".repeat(10) }));
  assert.equal(bad.composition, undefined);
  assert(bad.issues.some((x) => x.path === "scenes[0].title" && x.message.includes("fit")));
});

test("malformed and unsupported recipe content gets precise errors without throwing", () => {
  const base = brief(recipes[0]!);
  for (const scenes of [
    [null],
    [{ recipe: { toString: null } }],
    [{ ...recipes[0], image: null }],
    [{ ...recipes[2], steps: [null, 3] }],
  ])
    assert.doesNotThrow(() => composeMotionStory({ ...base, scenes }));
  const bad = composeMotionStory({
    ...base,
    scenes: [
      {
        ...recipes[1],
        before: {
          label: 9,
          image: { asset: "https://example.com/a.png", crop: { x: -1, y: 0, width: 5, height: 5 } },
        },
        magic: true,
      },
    ],
  });
  for (const path of [
    "scenes[0].before.label",
    "scenes[0].before.image.asset",
    "scenes[0].before.image.crop.x",
    "scenes[0].magic",
  ])
    assert(
      bad.issues.some((x) => x.path === path),
      path,
    );
  assert.equal(bad.composition, undefined);
});

test("existing scenes and optional audio pass through without aliasing input objects", () => {
  const base = brief(recipes[0]!);
  const existing = { id: "end", type: "title", durationS: 4, lines: ["Done."], motion: "off" };
  const audio = [{ id: "bed", kind: "music", asset: "bed.wav", atS: 0, durationS: 1 }];
  const result = composeMotionStory({ ...base, scenes: [recipes[0], existing], audio });
  assert(result.composition, JSON.stringify(result.issues));
  assert.deepEqual(result.composition.scenes[1], existing);
  assert.deepEqual(result.composition.audio, audio);
  assert.notEqual(result.composition.audio, audio);
});

test("story metadata survives recipe expansion and receives direct API advisories", () => {
  const base = brief(recipes[0]!);
  const story = {
    intent: "launch",
    audience: "People reviewing a concise product change.",
    takeaway: "The result is clear and grounded in the source.",
    beats: [
      { id: "context", sceneId: "focus", role: "context", message: "See the context." },
      {
        id: "promise",
        sceneId: "focus",
        role: "promise",
        message: "See the result.",
        evidence: [{ kind: "screenshot", layerId: "image" }],
      },
      { id: "action", sceneId: "focus", role: "action", message: "Review the details." },
    ],
  } as const;
  const clean = composeMotionStory({ ...base, story });
  assert(clean.composition, JSON.stringify(clean.issues));
  assert.deepEqual(clean.composition.story, story);
  assert.notEqual(clean.composition.story, story);
  assert.deepEqual(clean.issues, []);

  const advisory = composeMotionStory({
    ...base,
    story: { ...story, beats: story.beats.filter((beat) => beat.role !== "action") },
  });
  assert(advisory.composition, JSON.stringify(advisory.issues));
  assert(
    advisory.issues.some(
      (issue) => issue.severity === "warn" && issue.message.includes("No action beat"),
    ),
  );
});

test("provably poor recipe text contrast fails while arbitrary motion gets a warning", () => {
  const input = brief(recipes[0]!);
  input.theme.ink = input.theme.canvas;
  const result = composeMotionStory(input);
  assert.equal(result.composition, undefined);
  assert(
    result.issues.some(
      (x) =>
        x.severity === "error" &&
        x.path === "theme" &&
        x.message.startsWith("Text contrast") &&
        x.message.includes("theme.ink"),
    ),
  );
});

function quality(layers: MotionLayer[], durationS = 4): LaunchComposition {
  return { ...launchTemplate(), scenes: [{ id: "quality", type: "motion", durationS, layers }] };
}
const text = (extra: Partial<Extract<MotionLayer, { type: "text" }>> = {}): MotionLayer => ({
  id: "copy",
  type: "text",
  text: "A useful message",
  width: 500,
  height: 100,
  fontSize: 40,
  ...extra,
});

test("quality warns about resting bounds, tiny copy, known contrast, hold and dense motion", () => {
  const layers: MotionLayer[] = [
    text({
      x: 1100,
      fontSize: 10,
      fill: "#F5F2EA",
      animations: [
        {
          property: "reveal",
          keyframes: [
            { atS: 0, value: 0 },
            { atS: 4, value: 1 },
          ],
        },
      ],
    }),
    ...Array.from(
      { length: 9 },
      (_, i): MotionLayer => ({
        id: `box${i}`,
        type: "rect",
        width: 20,
        height: 20,
        x: -500 + i * 40,
        y: 250,
        animations: [
          {
            property: "y",
            keyframes: [
              { atS: 0, value: 200 },
              { atS: 4, value: 250 },
            ],
          },
        ],
      }),
    ),
  ];
  const issues = analyzeMotionQuality(quality(layers));
  for (const marker of [
    "Resting bounds",
    "Text is small",
    "Text contrast",
    "fully revealed hold",
    "layers animate simultaneously",
  ])
    assert(
      issues.some((x) => x.message.includes(marker)),
      marker,
    );
  assert(issues.every((x) => x.severity === "warn"));
});

test("quality ignores intentional offscreen entrances and handles parent transforms at rest", () => {
  const clean = quality([
    {
      id: "g",
      type: "group",
      x: 100,
      scaleX: 1.1,
      scaleY: 1.1,
      children: [text()],
      animations: [
        {
          property: "x",
          keyframes: [
            { atS: 0, value: -3000 },
            { atS: 0.5, value: 100 },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(analyzeMotionQuality(clean), []);
  const scene = clean.scenes[0]!;
  assert(scene.type === "motion");
  scene.layers[0]!.x = 1500;
  assert(
    analyzeMotionQuality(clean).some(
      (x) => x.path === "scenes[0].layers[0].children[0]" && x.message.startsWith("Resting bounds"),
    ),
  );
});

test("quality skips unknown image contrast and honors clipping", () => {
  const c = quality([
    {
      id: "g",
      type: "group",
      clip: true,
      width: 600,
      height: 300,
      children: [
        { id: "image", type: "image", asset: "photo.png", width: 3000, height: 1000 },
        text({ fill: "#F5F2EA" }),
      ],
    },
  ]);
  assert(
    !analyzeMotionQuality(c).some(
      (x) => x.message.startsWith("Resting bounds") || x.message.startsWith("Text contrast"),
    ),
  );
});

test("quality handles many unique animation intervals without quadratic endpoint scans", {
  timeout: 5000,
}, () => {
  const layers: MotionLayer[] = Array.from({ length: 200 }, (_, i) => ({
    id: `item-${i}`,
    type: "rect",
    width: 20,
    height: 20,
    x: (i % 20) * 25 - 250,
    y: Math.floor(i / 20) * 25 - 125,
    animations: [
      {
        property: "x",
        keyframes: Array.from({ length: 128 }, (_, j) => ({
          atS: j === 0 ? 0 : j / 128 + i / 100000,
          value: j % 2 === 0 ? 0 : 100,
        })),
      },
      {
        property: "y",
        keyframes: Array.from({ length: 128 }, (_, j) => ({
          atS: j === 0 ? 0 : j / 128 + i / 100001,
          value: j % 2 === 0 ? 0 : 100,
        })),
      },
    ],
  }));
  const issues = analyzeMotionQuality(quality(layers, 2));
  assert(issues.some((x) => x.message.includes("layers animate simultaneously")));
});

test("quality recognizes a reading hold before a later exit and merges redundant keys", () => {
  const c = quality(
    [
      text({
        animations: [
          {
            property: "x",
            keyframes: [
              { atS: 0, value: 0 },
              { atS: 1, value: 0 },
              { atS: 2, value: 0 },
              { atS: 3, value: 0 },
              { atS: 4, value: 1000 },
            ],
          },
        ],
      }),
    ],
    4,
  );
  assert(!analyzeMotionQuality(c).some((x) => x.message.includes("fully revealed hold")));
});
