import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Settings } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SettingsDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  theme: "system" | "light" | "dark";
  onThemeChange: (theme: "system" | "light" | "dark") => void;
  onConfigSaved?: () => void;
}

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; browser: string }
  | { status: "error"; message: string };

export function SettingsDialog({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  theme,
  onThemeChange,
  onConfigSaved,
}: SettingsDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;

  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  useEffect(() => {
    if (open) {
      setTest({ status: "idle" });
      window.cdp.getConfig().then((config) => {
        setHost(config.host);
        setPort(String(config.port));
      });
    }
  }, [open]);

  const parsedConfig = () => ({ host, port: parseInt(port, 10) || 9222 });

  const handleTest = async () => {
    setTest({ status: "testing" });
    const result = await window.cdp.testConfig(parsedConfig());
    if ("ok" in result) {
      setTest({ status: "ok", browser: result.browser });
    } else {
      setTest({ status: "error", message: result.error });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    await window.cdp.setConfig(parsedConfig());
    setSaving(false);
    setOpen(false);
    onConfigSaved?.();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 pt-2">
          {/* Theme */}
          <div className="space-y-2">
            <Label>Theme</Label>
            <Select value={theme} onValueChange={(v) => onThemeChange(v as any)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Remote connection */}
          <div className="space-y-2">
            <Label>Remote CDP Address</Label>
            <div className="flex gap-2">
              <Input
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  setTest({ status: "idle" });
                }}
                placeholder="Host"
                className="flex-1"
              />
              <Input
                value={port}
                onChange={(e) => {
                  setPort(e.target.value);
                  setTest({ status: "idle" });
                }}
                placeholder="Port"
                className="w-20"
                type="number"
              />
            </div>
            {test.status === "ok" && (
              <p className="text-[11px] text-emerald-500">
                Connected — {test.browser}
              </p>
            )}
            {test.status === "error" && (
              <p className="text-[11px] text-red-500">{test.message}</p>
            )}
            {test.status !== "ok" && test.status !== "error" && (
              <p className="text-[11px] text-muted-foreground">
                Saving reconnects the active tab.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={test.status === "testing"}
              className="flex-1"
            >
              {test.status === "testing" ? "Testing..." : "Test"}
            </Button>
            <Button onClick={handleSave} disabled={saving} className="flex-1">
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
