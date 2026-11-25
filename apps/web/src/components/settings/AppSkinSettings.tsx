import type { ChangeEvent, CSSProperties } from "react";
import { useRef, useState, useSyncExternalStore } from "react";
import { ImageIcon, Trash2Icon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import {
  type AppSkinFit,
  DEFAULT_APP_SKIN_FIT,
  DEFAULT_APP_SKIN_VEIL,
  MAX_APP_SKIN_VEIL,
  MIN_APP_SKIN_VEIL,
} from "@t3tools/contracts/settings";

import { APP_SKIN_ACCEPT } from "../../appSkinImage";
import {
  type AppSkinFailure,
  getAppSkinSnapshot,
  removeAppSkinImage,
  setAppSkinImage,
  subscribeAppSkin,
} from "../../appSkin";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const FIT_LABELS: Record<AppSkinFit, string> = {
  cover: msg("Fill", { $context: "skin image fills the window and may be cropped" }),
  contain: msg("Fit", { $context: "skin image fits inside the window without cropping" }),
  fill: msg("Stretch", { $context: "skin image is stretched to the window size" }),
  center: msg("Center", { $context: "skin image keeps its size in the middle of the window" }),
  tile: msg("Tile", { $context: "skin image repeats across the window" }),
};

const FIT_ORDER: ReadonlyArray<AppSkinFit> = ["cover", "contain", "fill", "center", "tile"];

const FAILURE_MESSAGES: Record<AppSkinFailure, string> = {
  unsupported: msg("Choose a PNG, JPEG, GIF, WebP, AVIF, or BMP image."),
  "too-large": msg("Choose an image of 32 MB or less."),
  unreadable: msg("This image could not be read. It may be damaged."),
  storage: msg("This browser could not save the image. Try again."),
};

function isAppSkinFit(value: unknown): value is AppSkinFit {
  return typeof value === "string" && FIT_ORDER.some((fit) => fit === value);
}

export function AppSkinSection() {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const skin = useSyncExternalStore(subscribeAppSkin, getAppSkinSnapshot, () => null);
  const [isBusy, setIsBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const veilRatio =
    (settings.appSkinVeil - MIN_APP_SKIN_VEIL) / (MAX_APP_SKIN_VEIL - MIN_APP_SKIN_VEIL);
  const veilSliderStyle = {
    "--settings-slider-progress": `${veilRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - veilRatio}rem`,
  } as CSSProperties;

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Clearing lets the same file be chosen again after a failure.
    input.value = "";
    if (!file) return;
    setIsBusy(true);
    const result = await setAppSkinImage(file);
    setIsBusy(false);
    if (!result.ok) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Couldn’t use this image"),
          description: m(FAILURE_MESSAGES[result.reason]),
        }),
      );
    }
  };

  const handleRemove = async () => {
    setIsBusy(true);
    const removed = await removeAppSkinImage();
    setIsBusy(false);
    if (!removed) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Couldn’t remove skin"),
          description: gt("Try again."),
        }),
      );
    }
  };

  return (
    <SettingsSection id="appearance-skin" title={gt("Skin")}>
      <SettingsRow
        {...searchableSetting("app-skin")}
        description={gt(
          "Show your own picture behind the app on this device. PNG, JPEG, GIF, WebP, AVIF, and BMP images up to 32 MB work.",
        )}
        control={
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            {skin ? (
              <img
                alt={skin.name}
                className="h-10 w-16 shrink-0 rounded-md border border-border object-cover"
                src={skin.url}
              />
            ) : null}
            <input
              ref={fileInputRef}
              accept={APP_SKIN_ACCEPT}
              className="sr-only"
              onChange={handleFileChange}
              tabIndex={-1}
              type="file"
            />
            <Button
              disabled={isBusy}
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon />
              {skin ? gt("Change image") : gt("Choose image")}
            </Button>
            {skin ? (
              <Button
                aria-label={gt("Remove skin")}
                disabled={isBusy}
                size="icon-sm"
                variant="ghost-destructive"
                onClick={handleRemove}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>
        }
      />
      {skin ? (
        <>
          <SettingsRow
            title={gt("Image fit")}
            description={gt("Choose how the image fills the window.")}
            resetAction={
              settings.appSkinFit !== DEFAULT_APP_SKIN_FIT ? (
                <SettingResetButton
                  ariaLabel={gt("Reset image fit to default")}
                  onClick={() => updateSettings({ appSkinFit: DEFAULT_APP_SKIN_FIT })}
                />
              ) : null
            }
            control={
              <div className="w-full sm:w-40">
                <Select
                  value={settings.appSkinFit}
                  onValueChange={(value) => {
                    if (isAppSkinFit(value)) updateSettings({ appSkinFit: value });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full min-w-0" aria-label={gt("Image fit")}>
                    <SelectValue>{m(FIT_LABELS[settings.appSkinFit])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {FIT_ORDER.map((fit) => (
                      <SelectItem key={fit} value={fit}>
                        {m(FIT_LABELS[fit])}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
          <SettingsRow
            title={gt("Tint")}
            description={gt(
              "Cover the image with the theme color. Higher values keep text easier to read.",
            )}
            resetAction={
              settings.appSkinVeil !== DEFAULT_APP_SKIN_VEIL ? (
                <SettingResetButton
                  ariaLabel={gt("Reset tint to default")}
                  onClick={() => updateSettings({ appSkinVeil: DEFAULT_APP_SKIN_VEIL })}
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center gap-3 sm:w-52">
                <output
                  className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="app-skin-veil"
                >
                  {settings.appSkinVeil}%
                </output>
                <input
                  aria-label={gt("Tint")}
                  className="settings-slider min-w-0 flex-1"
                  id="app-skin-veil"
                  max={MAX_APP_SKIN_VEIL}
                  min={MIN_APP_SKIN_VEIL}
                  onChange={(event) => {
                    const appSkinVeil = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(appSkinVeil) &&
                      appSkinVeil >= MIN_APP_SKIN_VEIL &&
                      appSkinVeil <= MAX_APP_SKIN_VEIL
                    ) {
                      updateSettings({ appSkinVeil });
                    }
                  }}
                  step={5}
                  style={veilSliderStyle}
                  type="range"
                  value={settings.appSkinVeil}
                />
              </div>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
