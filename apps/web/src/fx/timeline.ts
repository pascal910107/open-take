import type { MeshStandardMaterial } from "three";
import type { Cursor } from "./cursor";
import { type MockApp, growY, setOpacity } from "./mock-app";
import type { Rig } from "./rig";
import { Tweens, easeOutBack, easeOutCubic } from "./springs";

export interface HudHooks {
  shot(label: string): void;
}

export const LOOP = 16;

interface Beat {
  at: number;
  run(): void;
}

// The scripted take the hero performs, looped: establish → punch in on the
// metrics → create something in a modal → see the result land → travel to a
// second page → release. The same grammar the product shoots with.
export class Timeline {
  t = 0;
  private next = 0;
  private readonly tweens = new Tweens();
  private readonly beats: Beat[];

  // cursor and rig are closed over by the beats built below, never read off
  // `this` — so they stay plain parameters rather than private fields.
  constructor(
    private readonly app: MockApp,
    cursor: Cursor,
    rig: Rig,
    hooks: HudHooks,
  ) {
    const { targets } = app;
    const numW = 0.34;
    const numBaseX = app.statNumber.userData.baseX as number;

    const openModal = (): void => {
      app.modal.visible = true;
      setOpacity(app.modal, 0);
      app.modal.scale.setScalar(0.86);
      this.tweens.add(this.t, 0.3, easeOutCubic, (p) => setOpacity(app.modal, p));
      this.tweens.add(this.t, 0.42, easeOutBack, (p) => {
        app.modal.scale.setScalar(0.86 + 0.14 * p);
      });
    };

    const closeModal = (): void => {
      this.tweens.add(this.t, 0.22, easeOutCubic, (p) => {
        setOpacity(app.modal, 1 - p);
        app.modal.scale.setScalar(1 - 0.06 * p);
        if (p >= 1) app.modal.visible = false;
      });
    };

    this.beats = [
      {
        at: 0.3,
        run: () => {
          hooks.shot("01 WIDE — ESTABLISH");
          cursor.moveTo(0.95, -0.4);
        },
      },
      { at: 1.35, run: () => cursor.moveTo(targets.stat.position.x, targets.stat.position.y) },
      {
        at: 2.32,
        run: () => {
          this.tweens.add(this.t, 0.2, easeOutCubic, (p) => {
            app.statCard.position.z = 0.035 * p;
            app.statCard.scale.setScalar(1 + 0.02 * p);
          });
        },
      },
      {
        at: 2.62,
        run: () => {
          cursor.click(app.group);
          rig.punch(targets.stat, 2.9);
          hooks.shot("02 PUNCH-IN — METRICS ·730 MS");
          for (const [i, bar] of app.statBars.entries()) {
            this.tweens.add(
              this.t,
              0.5,
              easeOutCubic,
              (p) => growY(bar, 0.32 + 0.68 * p),
              0.24 + i * 0.08,
            );
          }
          this.tweens.add(
            this.t,
            0.45,
            easeOutCubic,
            (p) => {
              const s = 0.55 + 0.45 * p;
              app.statNumber.scale.x = s;
              app.statNumber.position.x = numBaseX + (numW * s) / 2;
            },
            0.2,
          );
        },
      },
      {
        at: 5.05,
        run: () => {
          rig.wide();
          hooks.shot("02R RELEASE — ×1.8 SLOWER");
          this.tweens.add(this.t, 0.3, easeOutCubic, (p) => {
            app.statCard.position.z = 0.035 * (1 - p);
            app.statCard.scale.setScalar(1 + 0.02 * (1 - p));
          });
        },
      },
      { at: 6.25, run: () => cursor.moveTo(targets.newBtn.position.x, targets.newBtn.position.y) },
      {
        at: 6.98,
        run: () => {
          cursor.click(app.group);
          rig.punch(targets.modal, 2.4);
          hooks.shot("03 INSERT — CREATE FLOW");
          openModal();
          cursor.moveTo(targets.modal.position.x - 0.3, targets.modal.position.y + 0.02);
        },
      },
      {
        at: 7.5,
        run: () => {
          this.app.caret.visible = true;
          for (const [i, chip] of app.chips.entries()) {
            const w = chip.userData.w as number;
            const baseX = chip.userData.baseX as number;
            this.tweens.add(
              this.t,
              0.13,
              easeOutCubic,
              (p) => {
                chip.visible = true;
                chip.scale.x = Math.max(p, 0.0001);
                chip.position.x = baseX + (w * p) / 2;
                if (p > 0.5) app.caret.position.x = baseX + w * p + 0.03;
              },
              i * 0.15,
            );
          }
        },
      },
      {
        at: 9.4,
        run: () => cursor.moveTo(targets.confirm.position.x, targets.confirm.position.y),
      },
      {
        at: 9.98,
        run: () => {
          cursor.click(app.group);
          app.caret.visible = false;
          closeModal();
          rig.punch(targets.content, 1.9);
          hooks.shot("04 THE RESULT — LANDED");
          this.tweens.add(
            this.t,
            0.34,
            easeOutBack,
            (p) => {
              app.toast.visible = true;
              setOpacity(app.toast, Math.min(1, p * 1.4));
              app.toast.position.y = 0.6 + 0.1 * (1 - p);
            },
            0.2,
          );
          this.tweens.add(
            this.t,
            0.55,
            easeOutCubic,
            (p) => {
              app.createdBar.visible = true;
              growY(app.createdBar, p);
              (app.createdBar.material as MeshStandardMaterial).emissiveIntensity =
                0.9 + 0.9 * (1 - p);
            },
            0.34,
          );
        },
      },
      {
        at: 11.55,
        run: () => {
          rig.wide();
          hooks.shot("04R RELEASE — ×1.8 SLOWER");
          this.tweens.add(
            this.t,
            0.3,
            easeOutCubic,
            (p) => {
              setOpacity(app.toast, 1 - p);
              if (p >= 1) app.toast.visible = false;
            },
            0.4,
          );
        },
      },
      { at: 12.45, run: () => cursor.moveTo(targets.side.position.x, targets.side.position.y) },
      {
        at: 13.02,
        run: () => {
          cursor.click(app.group);
          app.setSideActive(1);
          rig.punch(targets.content, 1.75);
          hooks.shot("05 TRAVEL — NAVIGATE");
          app.pageB.visible = true;
          app.pageB.position.x = 0.4;
          setOpacity(app.pageB, 0);
          this.tweens.add(this.t, 0.5, easeOutCubic, (p) => {
            app.pageA.position.x = -0.4 * p;
            setOpacity(app.pageA, 1 - p);
            if (p >= 1) app.pageA.visible = false;
          });
          this.tweens.add(
            this.t,
            0.5,
            easeOutCubic,
            (p) => {
              app.pageB.position.x = 0.4 * (1 - p);
              setOpacity(app.pageB, p);
            },
            0.1,
          );
        },
      },
      {
        at: 14.45,
        run: () => {
          rig.wide();
          hooks.shot("01 WIDE — ESTABLISH");
        },
      },
      { at: 15.3, run: () => cursor.moveTo(0.95, -0.4) },
    ];
  }

  get tau(): number {
    return this.t % LOOP;
  }

  update(dt: number): void {
    const before = this.tau;
    this.t += dt;
    if (this.tau < before) {
      while (this.next < this.beats.length) {
        this.beats[this.next]!.run();
        this.next++;
      }
      this.tweens.clear();
      this.app.reset();
      this.next = 0;
    }
    while (this.next < this.beats.length && this.beats[this.next]!.at <= this.tau) {
      this.beats[this.next]!.run();
      this.next++;
    }
    this.tweens.step(this.t);
  }
}
