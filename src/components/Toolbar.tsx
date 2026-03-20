import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Circle, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SettingsDialog } from "@/components/SettingsDialog";

interface ToolbarProps {
  url: string;
  sidebarCollapsed: boolean;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  status: string;
  fps: string;
  resolution: string;
  theme: "system" | "light" | "dark";
  onThemeChange: (theme: "system" | "light" | "dark") => void;
  isBookmarked: boolean;
  onToggleBookmark: () => void;
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
}

export interface ToolbarHandle {
  focusUrlBar: () => void;
}

export const Toolbar = forwardRef<ToolbarHandle, ToolbarProps>(function Toolbar({
  url,
  sidebarCollapsed,
  onNavigate,
  onBack,
  onForward,
  onReload,
  canGoBack,
  canGoForward,
  status,
  fps,
  resolution,
  theme,
  onThemeChange,
  isBookmarked,
  onToggleBookmark,
  settingsOpen,
  onSettingsOpenChange,
}, ref) {
  const isConnected = status === "Connected";
  const isError = status.startsWith("Error");

  const [draft, setDraft] = useState(url);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusUrlBar: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }));

  // Sync external URL into draft only when not focused
  useEffect(() => {
    if (!focused) {
      setDraft(url);
    }
  }, [url, focused]);

  const handleSubmit = () => {
    onNavigate(draft);
    inputRef.current?.blur();
  };

  const handleBlur = () => {
    setFocused(false);
    setDraft(url); // restore to actual URL
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 h-11 px-3 bg-card border-b border-border",
        sidebarCollapsed && "pl-20"
      )}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Nav buttons */}
      <div
        className="flex items-center gap-0.5"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onBack}
              disabled={!canGoBack}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onForward}
              disabled={!canGoForward}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
            >
              <ArrowRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Forward</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onReload}
              className="text-muted-foreground hover:text-foreground"
            >
              <RotateCw className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reload</TooltipContent>
        </Tooltip>
      </div>

      {/* URL bar */}
      <div
        className="flex-1 mx-2"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") inputRef.current?.blur();
          }}
          placeholder="Search or enter URL..."
          className="w-full h-7 px-3 text-xs bg-background border border-border rounded-full text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/25 transition-all"
        />
      </div>

      {/* Right side actions */}
      <div
        className="flex items-center gap-1 text-[10px] text-muted-foreground select-none shrink-0"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {fps && <span className="mr-1">{fps}</span>}
        {resolution && (
          <span className="hidden sm:inline mr-1">{resolution}</span>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center cursor-default">
              <Circle
                className={cn(
                  "size-2 fill-current",
                  isConnected
                    ? "text-emerald-500"
                    : isError
                      ? "text-red-500"
                      : "text-yellow-500"
                )}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>{status}</TooltipContent>
        </Tooltip>

        {/* Bookmark */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onToggleBookmark}
              className={cn(
                "hover:text-foreground",
                isBookmarked
                  ? "text-primary"
                  : "text-muted-foreground"
              )}
            >
              <Star
                className={cn(
                  "size-3.5",
                  isBookmarked && "fill-current"
                )}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isBookmarked ? "Remove bookmark" : "Bookmark this page"}
          </TooltipContent>
        </Tooltip>

        {/* Settings */}
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={onSettingsOpenChange}
          theme={theme}
          onThemeChange={onThemeChange}
        />
      </div>
    </div>
  );
});
