const { Plugin, PluginSettingTab, Setting, TFile, setIcon } = require("obsidian");

const DEFAULT_SETTINGS = {
  enabled: false,
  hiddenTags: [],
  hideInGraph: true
};

function normalizeTag(tag) {
  if (!tag) return "";
  const cleaned = String(tag).trim().toLowerCase();
  if (!cleaned) return "";
  return cleaned.startsWith("#") ? cleaned : `#${cleaned}`;
}

function normalizeTagList(tags) {
  const result = [];
  const seen = new Set();

  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function parseTagInput(value) {
  return normalizeTagList(String(value || "").split(/[\n, ]+/));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = class HideTagsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.ribbonIconEl = this.addRibbonIcon("eye", "Toggle tag hiding", async () => {
      await this.toggleEnabled();
    });
    this.updateRibbonIcon();

    this.addCommand({
      id: "toggle-tag-hiding",
      name: "Toggle tag hiding",
      callback: async () => {
        await this.toggleEnabled();
      }
    });

    this.addCommand({
      id: "apply-tag-filters-now",
      name: "Apply tag filters now",
      callback: () => this.refreshHiddenFiles()
    });

    this.addSettingTab(new HideTagsSettingTab(this.app, this));

    const refresh = () => this.refreshHiddenFiles();

    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
    this.registerEvent(this.app.workspace.on("layout-change", refresh));
    this.registerEvent(this.app.workspace.on("active-leaf-change", refresh));

    this.register(() => {
      document.body.classList.remove("hide-tags-enabled");
    });

    this.refreshHiddenFiles();
  }

  onunload() {
    document.body.classList.remove("hide-tags-enabled");
    this.refreshHiddenFiles(false);
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.hiddenTags = normalizeTagList(
      Array.isArray(this.settings.hiddenTags) ? this.settings.hiddenTags : []
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshHiddenFiles();
    this.updateRibbonIcon();
  }

  getGraphExclusionTokens() {
    return this.settings.hiddenTags.map((tag) => `-tag:${tag}`);
  }

  updateRibbonIcon() {
    if (!this.ribbonIconEl) return;

    const icon = this.settings.enabled ? "eye-off" : "eye";
    setIcon(this.ribbonIconEl, icon);

    const tagInfo = this.settings.hiddenTags.length
      ? `${this.settings.hiddenTags.length} tag(s) configured`
      : "no tags configured";

    const label = this.settings.enabled
      ? `Tag hiding enabled (${tagInfo})`
      : "Tag hiding disabled";

    this.ribbonIconEl.setAttribute("aria-label", label);
  }

  async toggleEnabled() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
  }

  isHiddenTagFile(file) {
    if (this.settings.hiddenTags.length === 0) return false;

    const fileCache = this.app.metadataCache.getFileCache(file);
    const hiddenTagSet = new Set(this.settings.hiddenTags);

    const inlineTags = fileCache?.tags?.map((t) => normalizeTag(t.tag)) ?? [];
    if (inlineTags.some((tag) => hiddenTagSet.has(tag))) return true;

    const fmTags = fileCache?.frontmatter?.tags;
    if (Array.isArray(fmTags)) {
      return fmTags
        .map((t) => normalizeTag(String(t)))
        .some((tag) => hiddenTagSet.has(tag));
    }

    if (typeof fmTags === "string") {
      return fmTags
        .split(/[ ,]+/)
        .map((t) => normalizeTag(t.trim()))
        .filter(Boolean)
        .some((tag) => hiddenTagSet.has(tag));
    }

    return false;
  }

  updateExplorerVisibility(shouldHide) {
    document.body.classList.toggle("hide-tags-enabled", shouldHide);

    const hiddenPaths = new Set();
    if (shouldHide && this.settings.hiddenTags.length) {
      for (const file of this.app.vault.getFiles()) {
        if (file instanceof TFile && this.isHiddenTagFile(file)) {
          hiddenPaths.add(file.path);
        }
      }
    }

    const explorerRows = document.querySelectorAll(".nav-file, .tree-item.nav-file");
    explorerRows.forEach((row) => {
      const path = row.getAttribute("data-path");
      if (!path) return;
      row.classList.toggle("hide-tags-hidden-file", shouldHide && hiddenPaths.has(path));
    });

    const explorerTitles = document.querySelectorAll(".nav-file-title[data-path]");
    explorerTitles.forEach((titleEl) => {
      const path = titleEl.getAttribute("data-path");
      if (!path) return;
      titleEl.classList.toggle("hide-tags-hidden-file", shouldHide && hiddenPaths.has(path));
    });
  }

  updateGraphFilters(shouldHide) {
    if (!this.settings.hideInGraph) return;

    const exclusionTokens = this.getGraphExclusionTokens();
    if (exclusionTokens.length === 0) return;

    const graphLeaves = this.app.workspace.getLeavesOfType("graph");
    const localGraphLeaves = this.app.workspace.getLeavesOfType("localgraph");

    [...graphLeaves, ...localGraphLeaves].forEach((leaf) => {
      const contentEl = leaf.view?.containerEl;
      if (!contentEl) return;

      const input = contentEl.querySelector(
        '.graph-controls input[type="search"], .graph-controls .search-input input'
      );
      if (!(input instanceof HTMLInputElement)) return;

      const current = input.value || "";
      let next = current;

      if (shouldHide) {
        for (const token of exclusionTokens) {
          if (!new RegExp(`(?:^|\\s)${escapeRegExp(token)}(?:$|\\s)`).test(next)) {
            next = `${next.trim()} ${token}`.trim();
          }
        }
      } else {
        for (const token of exclusionTokens) {
          const tokenRegex = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=$|\\s)`, "g");
          next = next.replace(tokenRegex, " ");
        }
        next = next.replace(/\s+/g, " ").trim();
      }

      if (next !== current) {
        if (document.activeElement === input) return;

        input.value = next;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  }

  refreshHiddenFiles(respectMode = true) {
    const shouldHide = respectMode ? this.settings.enabled : false;
    this.updateExplorerVisibility(shouldHide);
    this.updateGraphFilters(shouldHide);
  }
};

class HideTagsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("hide-tags-settings-view");

    containerEl.createEl("p", {
      text: "Hide notes by tag. When enabled, any note containing a configured tag is hidden.",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Enable Tag Hiding")
      .setDesc("Hide notes with matching tags in File Explorer and (optionally) Graph views.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        })
      );

    const tagManagerSetting = new Setting(containerEl)
      .setName("Tags To Hide")
      .setDesc("Add tags like #private, #spoiler, #archive. Any match will be hidden when enabled.");
    tagManagerSetting.settingEl.addClass("hide-tags-setting-stack");

    const managerEl = tagManagerSetting.controlEl.createDiv({ cls: "hide-tags-manager" });
    const inputWrapEl = managerEl.createDiv({ cls: "hide-tags-input-row" });

    const tagInputEl = inputWrapEl.createEl("input", {
      type: "text",
      placeholder: "Add tag (e.g. #private)"
    });

    const addBtn = inputWrapEl.createEl("button", { text: "Add tag", cls: "mod-cta" });
    const chipsEl = managerEl.createDiv({ cls: "hide-tags-chip-list" });

    const saveAndRefreshSettings = async () => {
      this.plugin.settings.hiddenTags = normalizeTagList(this.plugin.settings.hiddenTags);
      await this.plugin.saveSettings();
      renderChips();
    };

    const addTag = async () => {
      const parsed = parseTagInput(tagInputEl.value);
      if (parsed.length === 0) return;

      this.plugin.settings.hiddenTags = normalizeTagList([
        ...this.plugin.settings.hiddenTags,
        ...parsed
      ]);

      tagInputEl.value = "";
      await saveAndRefreshSettings();
    };

    const removeTag = async (tagToRemove) => {
      this.plugin.settings.hiddenTags = this.plugin.settings.hiddenTags.filter(
        (tag) => tag !== tagToRemove
      );
      await saveAndRefreshSettings();
    };

    const renderChips = () => {
      chipsEl.empty();

      this.plugin.settings.hiddenTags.forEach((tag) => {
        const chip = chipsEl.createDiv({ cls: "hide-tags-chip" });
        chip.createSpan({ text: tag, cls: "hide-tags-chip-label" });

        const removeBtn = chip.createEl("button", { cls: "hide-tags-chip-remove" });
        setIcon(removeBtn, "x");
        removeBtn.addClass("hide-tags-chip-remove-subtle");
        removeBtn.setAttribute("aria-label", `Remove ${tag}`);
        removeBtn.addEventListener("click", async () => {
          await removeTag(tag);
        });
      });
    };

    addBtn.addEventListener("click", async () => {
      await addTag();
    });

    tagInputEl.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        await addTag();
      }
    });

    renderChips();

    new Setting(containerEl)
      .setName("Filter Graph Views")
      .setDesc("When enabled, configured tags are added as exclusions in Graph/Local Graph search.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideInGraph).onChange(async (value) => {
          this.plugin.settings.hideInGraph = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
