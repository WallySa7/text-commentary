import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	MarkdownPostProcessorContext,
	MarkdownRenderer,
	Menu,
} from "obsidian";

interface CommentaryPluginSettings {
	defaultCollapsed: boolean;
	highlightDuration: number;
	footnotePrefix: string;
	enableQuickToolbar: boolean;
	defaultFootnoteType: string;
	enableStatistics: boolean;
	enableBlockTags: boolean;
}

const DEFAULT_SETTINGS: CommentaryPluginSettings = {
	defaultCollapsed: false,
	highlightDuration: 2000,
	footnotePrefix: "note",
	enableQuickToolbar: true,
	defaultFootnoteType: "note",
	enableStatistics: true,
	enableBlockTags: true,
};

// Footnote types with icons and colors
const FOOTNOTE_TYPES = {
	note: { icon: "📝", color: "var(--text-normal)" },
	warning: { icon: "⚠️", color: "var(--text-warning)" },
	info: { icon: "ℹ️", color: "var(--text-accent)" },
	reference: { icon: "📚", color: "var(--text-muted)" },
	idea: { icon: "💡", color: "var(--interactive-accent)" },
	question: { icon: "❓", color: "var(--text-error)" },
};

export default class CommentaryPlugin extends Plugin {
	settings: CommentaryPluginSettings;
	blockCounter: number = 0;
	blockRegistry: Map<string, any> = new Map();

	async onload() {
		await this.loadSettings();

		// Register the code block processor for commentary blocks
		this.registerMarkdownCodeBlockProcessor(
			"commentary",
			(source, el, ctx) => {
				this.processCommentaryBlock(source, el, ctx);
			}
		);

		// Add command to insert commentary block
		this.addCommand({
			id: "insert-commentary-block",
			name: "Insert Commentary Block",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.insertCommentaryBlock(editor);
			},
			hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "c" }],
		});

		// Add command to insert footnote
		this.addCommand({
			id: "insert-footnote",
			name: "Insert Footnote in Commentary Block",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.insertFootnote(editor);
			},
			hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "f" }],
		});

		// Add command for multi-line footnote
		this.addCommand({
			id: "insert-multiline-footnote",
			name: "Insert Multi-line Footnote",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.insertMultilineFootnote(editor);
			},
			hotkeys: [{ modifiers: ["Ctrl", "Alt"], key: "f" }],
		});

		// Add command to toggle all blocks
		this.addCommand({
			id: "toggle-all-blocks",
			name: "Toggle All Commentary Blocks",
			callback: () => {
				this.toggleAllBlocks();
			},
		});

		// Add settings tab
		this.addSettingTab(new CommentarySettingTab(this.app, this));

		// Add styles
		this.addStyles();
	}

	processCommentaryBlock(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) {
		const blockId = `commentary-block-${this.blockCounter++}`;

		// Parse the source content
		const { originalText, commentary, metadata } =
			this.parseBlockContent(source);

		// Store block data for later reference
		this.blockRegistry.set(blockId, { originalText, commentary, metadata });

		// Create the block container
		const container = el.createDiv({ cls: "commentary-block-container" });
		container.setAttribute("data-block-id", blockId);

		// Add tags if enabled and present
		if (this.settings.enableBlockTags && metadata.tags) {
			const tagsContainer = container.createDiv({
				cls: "commentary-block-tags",
			});
			metadata.tags.forEach((tag: string) => {
				tagsContainer.createEl("span", {
					cls: "commentary-tag",
					text: `#${tag}`,
				});
			});
		}

		// Create header with collapse button and title
		const header = container.createDiv({ cls: "commentary-block-header" });
		const collapseBtn = header.createEl("button", {
			cls: "commentary-collapse-btn",
			text: this.settings.defaultCollapsed ? "▶" : "▼",
		});

		const title = header.createEl("span", {
			cls: "commentary-block-title",
			text: metadata.title || "Commentary Block",
		});

		// Add quick toolbar if enabled
		if (this.settings.enableQuickToolbar) {
			const toolbar = header.createDiv({ cls: "commentary-toolbar" });
			this.createQuickToolbar(toolbar, blockId);
		}

		// Create content container
		const content = container.createDiv({
			cls: "commentary-block-content",
		});

		if (this.settings.defaultCollapsed) {
			content.addClass("collapsed");
		}

		// Add original text section
		if (originalText.trim()) {
			const textSection = content.createDiv({
				cls: "commentary-original-text",
			});
			const textHeader = textSection.createEl("h4", {
				text: "Original Text (متن)",
			});
			const textContent = textSection.createDiv({
				cls: "original-text-content",
			});
			MarkdownRenderer.renderMarkdown(
				originalText,
				textContent,
				"",
				null
			);
		}

		// Process and add commentary with footnotes
		const commentarySection = content.createDiv({
			cls: "commentary-section",
		});
		const commentaryHeader = commentarySection.createEl("h4", {
			text: "Commentary",
		});

		// Add statistics if enabled
		if (this.settings.enableStatistics) {
			const stats = this.calculateStatistics(commentary);
			const statsEl = commentaryHeader.createEl("span", {
				cls: "commentary-stats",
				text: ` (${stats.words} words, ${stats.footnotes} footnotes)`,
			});
		}

		const commentaryContent = commentarySection.createDiv({
			cls: "commentary-content",
		});

		// Process footnotes in commentary
		const { processedText, footnotes } = this.processFootnotes(
			commentary,
			blockId
		);

		// Render the processed commentary
		const commentaryBody = commentaryContent.createDiv({
			cls: "commentary-body",
		});
		this.renderCommentaryWithFootnotes(
			processedText,
			commentaryBody,
			blockId
		);

		// Add footnotes section if there are any
		if (footnotes.length > 0) {
			const footnotesSection = commentaryContent.createDiv({
				cls: "commentary-footnotes",
			});
			const footnotesHeader = footnotesSection.createEl("h5", {
				text: "Footnotes",
			});
			const footnotesList = footnotesSection.createEl("ol", {
				cls: "footnotes-list",
			});

			footnotes.forEach((footnote, index) => {
				const li = footnotesList.createEl("li");
				li.setAttribute("id", `${blockId}-footnote-${index + 1}`);
				li.setAttribute("data-footnote-num", String(index + 1));

				// Parse footnote type and content
				const { type, content } = this.parseFootnoteContent(footnote);
				const footnoteType =
					FOOTNOTE_TYPES[type] || FOOTNOTE_TYPES.note;

				// Add type icon
				if (footnoteType.icon) {
					li.createEl("span", {
						cls: "footnote-type-icon",
						text: footnoteType.icon + " ",
					});
				}

				// Add back reference
				const backRef = li.createEl("a", {
					cls: "footnote-backref",
					text: "↩",
					href: `#${blockId}-ref-${index + 1}`,
				});
				backRef.addEventListener("click", (e) => {
					e.preventDefault();
					this.scrollToAndHighlight(`${blockId}-ref-${index + 1}`);
				});

				li.createEl("span", { text: " " });

				// Render footnote content
				const footnoteContent = li.createEl("span", {
					cls: "footnote-text",
				});
				footnoteContent.style.color = footnoteType.color;

				// Handle multi-line footnotes
				const tempDiv = document.createElement("div");
				MarkdownRenderer.renderMarkdown(content, tempDiv, "", null);

				// Process rendered content to maintain proper formatting
				this.processFootnoteContent(tempDiv, footnoteContent);
			});
		}

		// Add collapse functionality
		collapseBtn.addEventListener("click", () => {
			content.classList.toggle("collapsed");
			collapseBtn.textContent = content.classList.contains("collapsed")
				? "▶"
				: "▼";
		});
	}

	parseBlockContent(source: string) {
		const lines = source.split("\n");
		let originalText = "";
		let commentary = "";
		let metadata: any = {};
		let currentSection = "";

		for (const line of lines) {
			if (line.startsWith("---text---")) {
				currentSection = "text";
				continue;
			}
			if (line.startsWith("---commentary---")) {
				currentSection = "commentary";
				continue;
			}
			if (line.startsWith("---metadata---")) {
				currentSection = "metadata";
				continue;
			}

			switch (currentSection) {
				case "text":
					originalText += line + "\n";
					break;
				case "commentary":
					commentary += line + "\n";
					break;
				case "metadata":
					// Parse metadata lines (e.g., title: My Title, tags: tag1, tag2)
					const metaMatch = line.match(/^(\w+):\s*(.+)$/);
					if (metaMatch) {
						const [, key, value] = metaMatch;
						if (key === "tags") {
							metadata[key] = value
								.split(",")
								.map((t) => t.trim());
						} else {
							metadata[key] = value.trim();
						}
					}
					break;
			}
		}

		return { originalText, commentary, metadata };
	}

	processFootnotes(
		text: string,
		blockId: string
	): { processedText: string; footnotes: string[] } {
		const footnotes: string[] = [];
		let footnoteCounter = 0;

		// Enhanced patterns for single and multi-line footnotes
		const singleLinePattern = /\{\{fn(?::(\w+))?:(.*?)\}\}/g;
		const multiLinePattern = /\{\{fn(?::(\w+))?\[\[([\s\S]*?)\]\]\}\}/g;

		// First process multi-line footnotes
		let processedText = text.replace(
			multiLinePattern,
			(match, type, footnoteText) => {
				footnoteCounter++;
				const fullNote = type
					? `${type}:${footnoteText.trim()}`
					: footnoteText.trim();
				footnotes.push(fullNote);
				return `{{fnref:${footnoteCounter}}}`;
			}
		);

		// Then process single-line footnotes
		processedText = processedText.replace(
			singleLinePattern,
			(match, type, footnoteText) => {
				footnoteCounter++;
				const fullNote = type
					? `${type}:${footnoteText.trim()}`
					: footnoteText.trim();
				footnotes.push(fullNote);
				return `{{fnref:${footnoteCounter}}}`;
			}
		);

		return { processedText, footnotes };
	}

	parseFootnoteContent(footnote: string): { type: string; content: string } {
		const typeMatch = footnote.match(/^(\w+):(.*)$/s);
		if (typeMatch && FOOTNOTE_TYPES[typeMatch[1]]) {
			return { type: typeMatch[1], content: typeMatch[2].trim() };
		}
		return { type: "note", content: footnote };
	}

	processFootnoteContent(source: HTMLElement, target: HTMLElement) {
		// Handle multi-line content properly
		let isFirstParagraph = true;

		while (source.firstChild) {
			const node = source.firstChild;

			if (node.nodeName === "P") {
				const p = node as HTMLElement;

				if (isFirstParagraph) {
					// First paragraph: extract inline content
					while (p.firstChild) {
						target.appendChild(p.firstChild);
					}
					isFirstParagraph = false;
				} else {
					// Subsequent paragraphs: add line break and content
					target.appendChild(document.createElement("br"));
					target.appendChild(document.createElement("br"));
					while (p.firstChild) {
						target.appendChild(p.firstChild);
					}
				}
				source.removeChild(p);
			} else if (node.nodeName === "UL" || node.nodeName === "OL") {
				// Preserve lists
				target.appendChild(document.createElement("br"));
				target.appendChild(node);
			} else if (node.nodeName === "BLOCKQUOTE") {
				// Preserve blockquotes with styling
				target.appendChild(document.createElement("br"));
				const blockquote = node as HTMLElement;
				blockquote.style.marginLeft = "1em";
				blockquote.style.paddingLeft = "0.5em";
				blockquote.style.borderLeft = "3px solid var(--quote-border)";
				target.appendChild(blockquote);
			} else if (node.nodeName === "PRE") {
				// Preserve code blocks
				target.appendChild(document.createElement("br"));
				target.appendChild(node);
			} else {
				target.appendChild(node);
			}
		}
	}

	renderCommentaryWithFootnotes(
		text: string,
		container: HTMLElement,
		blockId: string
	) {
		// First, render the entire markdown content
		const tempContainer = document.createElement("div");
		MarkdownRenderer.renderMarkdown(text, tempContainer, "", null);

		// Now process the rendered content to replace footnote markers
		const processNode = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				const textContent = node.textContent || "";
				const fnRefPattern = /\{\{fnref:(\d+)\}\}/g;

				if (fnRefPattern.test(textContent)) {
					const fragment = document.createDocumentFragment();
					let lastIndex = 0;
					let match;

					fnRefPattern.lastIndex = 0; // Reset regex
					while ((match = fnRefPattern.exec(textContent)) !== null) {
						// Add text before the footnote
						if (match.index > lastIndex) {
							fragment.appendChild(
								document.createTextNode(
									textContent.slice(lastIndex, match.index)
								)
							);
						}

						// Create footnote reference
						const num = match[1];
						const sup = document.createElement("sup");
						sup.className = "footnote-ref";
						const link = document.createElement("a");
						link.textContent = `[${num}]`;
						link.href = `#${blockId}-footnote-${num}`;
						link.id = `${blockId}-ref-${num}`;
						link.addEventListener("click", (e) => {
							e.preventDefault();
							this.scrollToAndHighlight(
								`${blockId}-footnote-${num}`
							);
						});
						sup.appendChild(link);
						fragment.appendChild(sup);

						lastIndex = match.index + match[0].length;
					}

					// Add remaining text
					if (lastIndex < textContent.length) {
						fragment.appendChild(
							document.createTextNode(
								textContent.slice(lastIndex)
							)
						);
					}

					// Replace the text node with the fragment
					if (node.parentNode) {
						node.parentNode.replaceChild(fragment, node);
					}
				}
			} else if (node.nodeType === Node.ELEMENT_NODE) {
				// Recursively process child nodes
				const children = Array.from(node.childNodes);
				children.forEach((child) => processNode(child));
			}
		};

		// Process all nodes in the temporary container
		Array.from(tempContainer.childNodes).forEach((node) =>
			processNode(node)
		);

		// Move processed content to the actual container
		while (tempContainer.firstChild) {
			container.appendChild(tempContainer.firstChild);
		}
	}

	createQuickToolbar(toolbar: HTMLElement, blockId: string) {
		// Copy block ID button
		const copyBtn = toolbar.createEl("button", {
			cls: "toolbar-btn",
			attr: { "aria-label": "Copy Block ID" },
		});
		copyBtn.innerHTML = "🔗";
		copyBtn.addEventListener("click", async () => {
			await navigator.clipboard.writeText(`[[#${blockId}]]`);
			new Notice("Block reference copied!");
		});

		// Export button
		const exportBtn = toolbar.createEl("button", {
			cls: "toolbar-btn",
			attr: { "aria-label": "Export Block" },
		});
		exportBtn.innerHTML = "📤";
		exportBtn.addEventListener("click", () => {
			this.exportBlock(blockId);
		});

		// Statistics button
		if (this.settings.enableStatistics) {
			const statsBtn = toolbar.createEl("button", {
				cls: "toolbar-btn",
				attr: { "aria-label": "Show Statistics" },
			});
			statsBtn.innerHTML = "📊";
			statsBtn.addEventListener("click", () => {
				this.showBlockStatistics(blockId);
			});
		}
	}

	calculateStatistics(text: string): { words: number; footnotes: number } {
		const words = text
			.split(/\s+/)
			.filter((word) => word.length > 0).length;
		const footnoteMatches = text.match(/\{\{fn.*?\}\}/g);
		const multiFootnoteMatches = text.match(
			/\{\{fn.*?\[\[[\s\S]*?\]\]\}\}/g
		);
		const footnotes =
			(footnoteMatches?.length || 0) +
			(multiFootnoteMatches?.length || 0);

		return { words, footnotes };
	}

	exportBlock(blockId: string) {
		const blockData = this.blockRegistry.get(blockId);
		if (!blockData) return;

		const exportContent = `# Commentary Block Export\n\n## Original Text\n${blockData.originalText}\n\n## Commentary\n${blockData.commentary}`;

		const blob = new Blob([exportContent], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `commentary-block-${blockId}.md`;
		a.click();
		URL.revokeObjectURL(url);

		new Notice("Block exported successfully!");
	}

	showBlockStatistics(blockId: string) {
		const blockData = this.blockRegistry.get(blockId);
		if (!blockData) return;

		const stats = this.calculateStatistics(blockData.commentary);
		const originalStats = this.calculateStatistics(blockData.originalText);

		new Notice(`📊 Block Statistics:
Original Text: ${originalStats.words} words
Commentary: ${stats.words} words
Footnotes: ${stats.footnotes}
Ratio: ${(stats.words / originalStats.words).toFixed(2)}x`);
	}

	toggleAllBlocks() {
		const blocks = document.querySelectorAll(".commentary-block-content");
		const shouldCollapse = !document.querySelector(
			".commentary-block-content.collapsed"
		);

		blocks.forEach((block) => {
			if (shouldCollapse) {
				block.classList.add("collapsed");
			} else {
				block.classList.remove("collapsed");
			}

			const btn = block.parentElement?.querySelector(
				".commentary-collapse-btn"
			);
			if (btn) {
				btn.textContent = shouldCollapse ? "▶" : "▼";
			}
		});

		new Notice(`All blocks ${shouldCollapse ? "collapsed" : "expanded"}`);
	}

	scrollToAndHighlight(elementId: string) {
		const element = document.getElementById(elementId);
		if (element) {
			element.scrollIntoView({ behavior: "smooth", block: "center" });
			element.classList.add("highlight-flash");
			setTimeout(() => {
				element.classList.remove("highlight-flash");
			}, this.settings.highlightDuration);
		}
	}

	insertCommentaryBlock(editor: Editor) {
		const template = `\`\`\`commentary
---metadata---
title: Commentary on [Topic]
tags: analysis, notes

---text---
[Insert the original text to comment on here / متن اصلی را اینجا وارد کنید]

---commentary---
Your commentary goes here. 

Single-line footnote: {{fn:Your footnote text here}}
Multi-line footnote: {{fn[[
This is a multi-line footnote.
You can write multiple paragraphs here.

- Even lists
- Work perfectly
]]}}

Typed footnotes:
- Note: {{fn:note:This is a regular note}}
- Warning: {{fn:warning:Important warning here}}
- Info: {{fn:info:Additional information}}
- Reference: {{fn:reference:Source citation}}
- Idea: {{fn:idea:A brilliant idea}}
- Question: {{fn:question:Something to investigate}}
\`\`\``;

		editor.replaceSelection(template);
	}

	insertFootnote(editor: Editor) {
		const cursor = editor.getCursor();

		// Check if we're inside a commentary block
		if (!this.isInCommentaryBlock(editor, cursor.line)) {
			new Notice(
				"Place cursor inside a commentary block to insert a footnote"
			);
			return;
		}

		const footnoteTemplate = `{{fn:${this.settings.defaultFootnoteType}:}}`;
		editor.replaceSelection(footnoteTemplate);

		// Position cursor inside the footnote
		const typeLength = this.settings.defaultFootnoteType.length;
		const newCursor = {
			line: cursor.line,
			ch: cursor.ch + 5 + typeLength + 1,
		};
		editor.setCursor(newCursor);
	}

	insertMultilineFootnote(editor: Editor) {
		const cursor = editor.getCursor();

		if (!this.isInCommentaryBlock(editor, cursor.line)) {
			new Notice(
				"Place cursor inside a commentary block to insert a footnote"
			);
			return;
		}

		const footnoteTemplate = `{{fn:${this.settings.defaultFootnoteType}:[[]]}}`;

		editor.replaceSelection(footnoteTemplate);

		const typeLength = this.settings.defaultFootnoteType.length;

		// Position cursor inside the multi-line footnote
		const newLine = cursor.line + 1;
		editor.setCursor({
			line: cursor.line,
			ch: cursor.ch + 5 + typeLength + 3,
		});
	}

	isInCommentaryBlock(editor: Editor, line: number): boolean {
		for (let i = line; i >= 0; i--) {
			const checkLine = editor.getLine(i);
			if (checkLine.startsWith("```commentary")) {
				return true;
			}
			if (checkLine.startsWith("```") && i < line) {
				return false;
			}
		}
		return false;
	}

	addStyles() {
		const style = document.createElement("style");
		style.textContent = `
            .commentary-block-container {
                border: 1px solid var(--background-modifier-border);
                border-radius: 8px;
                margin: 1em 0;
                padding: 0;
                background: var(--background-primary);
                position: relative;
            }
            
            .commentary-block-tags {
                padding: 8px 15px;
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
            }
            
            .commentary-tag {
                display: inline-block;
                padding: 2px 8px;
                background: var(--tag-background);
                color: var(--tag-color);
                border-radius: 12px;
                font-size: 0.85em;
                cursor: pointer;
                transition: opacity 0.2s;
            }
            
            .commentary-tag:hover {
                opacity: 0.8;
            }
            
            .commentary-block-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 15px;
                background: var(--background-secondary);
                border-radius: 8px 8px 0 0;
                cursor: pointer;
                user-select: none;
            }
            
            .commentary-collapse-btn {
                background: none;
                border: none;
                cursor: pointer;
                font-size: 12px;
                margin-right: 10px;
				margin-left: 0;
                padding: 0;
                width: 20px;
                color: var(--text-muted);
                transition: transform 0.2s;
            }

			.is-rtl .commentary-collapse-btn {
				margin-left: 10px;
				margin-right: 0;
			}
            
            .commentary-collapse-btn:hover {
                color: var(--text-normal);
            }
            
            .commentary-block-title {
                font-weight: 600;
                color: var(--text-normal);
                flex-grow: 1;
            }
            
            .commentary-toolbar {
                display: flex;
                gap: 5px;
                margin-left: auto;
            }
            
            .toolbar-btn {
                background: none;
                border: none;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 14px;
                transition: background 0.2s;
            }
            
            .toolbar-btn:hover {
                background: var(--background-modifier-hover);
            }
            
            .commentary-block-content {
                padding: 15px;
                max-height: 3000px;
                overflow: hidden;
                transition: max-height 0.3s ease-out, padding 0.3s ease-out;
            }
            
            .commentary-block-content.collapsed {
                max-height: 0;
                padding: 0 15px;
            }
            
            .commentary-original-text {
                background: var(--background-secondary-alt);
                border-radius: 6px;
                padding: 12px;
                margin-bottom: 15px;
                border-left: 3px solid var(--quote-border);
            }
            
            .commentary-original-text h4 {
                margin-top: 0;
                margin-bottom: 10px;
                color: var(--text-muted);
                font-size: 0.9em;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            
            .original-text-content {
                color: var(--text-normal);
                font-style: italic;
            }
            
            .commentary-section h4 {
                margin-top: 0;
                margin-bottom: 10px;
                color: var(--text-muted);
                font-size: 0.9em;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                display: flex;
                align-items: center;
            }
            
            .commentary-stats {
                font-size: 0.85em;
                color: var(--text-faint);
                font-weight: normal;
                margin-left: 10px;
            }
            
            .commentary-content {
                color: var(--text-normal);
            }
            
            .commentary-body {
                line-height: 1.6;
            }
            
            .commentary-body p {
                margin-top: 0;
                margin-bottom: 1em;
            }
            
            .commentary-body p:last-child {
                margin-bottom: 0;
            }
            
            .footnote-ref {
                margin: 0 2px;
                display: inline;
                vertical-align: super;
            }
            
            .footnote-ref a {
                color: var(--link-color);
                text-decoration: none;
                font-weight: 600;
                padding: 0 2px;
                display: inline;
                transition: all 0.2s;
            }
            
            .footnote-ref a:hover {
                color: var(--link-color-hover);
                text-decoration: underline;
                background: var(--background-modifier-hover);
                border-radius: 3px;
            }
            
            .commentary-footnotes {
                margin-top: 20px;
                padding-top: 15px;
                border-top: 1px solid var(--background-modifier-border);
            }
            
            .commentary-footnotes h5 {
                margin-top: 0;
                margin-bottom: 10px;
                color: var(--text-muted);
                font-size: 0.85em;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            
            .footnotes-list {
                margin: 0;
                padding-left: 20px;
                font-size: 0.9em;
            }
            
            .footnotes-list li {
                margin-bottom: 12px;
                color: var(--text-muted);
                line-height: 1.5;
            }
            
            .footnote-type-icon {
                display: inline;
                margin-right: 4px;
            }
            
            .footnote-text {
                display: inline;
                color: var(--text-normal);
            }
            
            .footnote-text p {
                display: inline;
                margin: 0;
            }
            
            .footnote-text br + br {
                display: block;
                content: "";
                margin: 0.5em 0;
            }
            
            .footnote-text ul,
            .footnote-text ol {
                margin: 0.5em 0;
                padding-left: 1.5em;
            }
            
            .footnote-text blockquote {
                margin: 0.5em 0;
                padding-left: 1em;
                border-left: 3px solid var(--quote-border);
            }
            
            .footnote-text pre {
                margin: 0.5em 0;
                padding: 0.5em;
                background: var(--code-background);
                border-radius: 4px;
            }
            
            .footnote-backref {
                color: var(--link-color);
                text-decoration: none;
                margin-right: 5px;
                font-size: 0.9em;
                transition: all 0.2s;
            }
            
            .footnote-backref:hover {
                color: var(--link-color-hover);
                transform: translateX(-2px);
            }
            
            .highlight-flash {
                animation: highlightFlash 2s ease-out;
            }
            
            @keyframes highlightFlash {
                0% {
                    background-color: var(--interactive-accent);
                    opacity: 0.3;
                    transform: scale(1.05);
                }
                50% {
                    transform: scale(1);
                }
                100% {
                    background-color: transparent;
                    opacity: 1;
                }
            }
            
            /* Mobile compatibility */
            @media (max-width: 768px) {
                .commentary-block-container {
                    margin: 0.5em 0;
                }
                
                .commentary-block-header {
                    padding: 8px 12px;
                    flex-direction: column;
                    align-items: flex-start;
                }
                
                .commentary-toolbar {
                    margin-top: 8px;
                    margin-left: 0;
                }
                
                .commentary-block-content {
                    padding: 12px;
                }
                
                .commentary-original-text,
                .commentary-section {
                    padding: 10px;
                }
                
                .footnotes-list {
                    padding-left: 15px;
                }
            }
            
            /* Dark mode enhancements */
            .theme-dark .commentary-block-container {
                background: var(--background-primary);
                border-color: var(--background-modifier-border);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            }
            
            .theme-dark .commentary-block-header {
                background: var(--background-secondary);
            }
            
            .theme-dark .commentary-original-text {
                background: var(--background-secondary-alt);
            }
            
            .theme-dark .commentary-tag {
                background: var(--background-modifier-hover);
                color: var(--text-normal);
            }
            
            /* Print styles */
            @media print {
                .commentary-toolbar,
                .commentary-collapse-btn {
                    display: none !important;
                }
                
                .commentary-block-content {
                    max-height: none !important;
                    padding: 15px !important;
                }
                
                .commentary-block-content.collapsed {
                    max-height: none !important;
                }
            }
        `;
		document.head.appendChild(style);
	}

	onunload() {
		// Cleanup
		this.blockRegistry.clear();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class CommentarySettingTab extends PluginSettingTab {
	plugin: CommentaryPlugin;

	constructor(app: App, plugin: CommentaryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Commentary Plugin Settings" });

		new Setting(containerEl)
			.setName("Default Collapsed State")
			.setDesc("Whether commentary blocks should be collapsed by default")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.defaultCollapsed)
					.onChange(async (value) => {
						this.plugin.settings.defaultCollapsed = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable Quick Toolbar")
			.setDesc("Show quick action buttons in block headers")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableQuickToolbar)
					.onChange(async (value) => {
						this.plugin.settings.enableQuickToolbar = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable Statistics")
			.setDesc("Show word and footnote counts")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableStatistics)
					.onChange(async (value) => {
						this.plugin.settings.enableStatistics = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable Block Tags")
			.setDesc("Allow tagging commentary blocks for organization")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableBlockTags)
					.onChange(async (value) => {
						this.plugin.settings.enableBlockTags = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default Footnote Type")
			.setDesc("Default type for new footnotes")
			.addDropdown((dropdown) => {
				Object.keys(FOOTNOTE_TYPES).forEach((type) => {
					dropdown.addOption(type, type);
				});
				dropdown
					.setValue(this.plugin.settings.defaultFootnoteType)
					.onChange(async (value) => {
						this.plugin.settings.defaultFootnoteType = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Highlight Duration")
			.setDesc(
				"Duration of the highlight animation when jumping to footnotes (in milliseconds)"
			)
			.addText((text) =>
				text
					.setPlaceholder("2000")
					.setValue(String(this.plugin.settings.highlightDuration))
					.onChange(async (value) => {
						const num = parseInt(value);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.highlightDuration = num;
							await this.plugin.saveSettings();
						}
					})
			);

		containerEl.createEl("h3", { text: "Keyboard Shortcuts" });
		const shortcutsEl = containerEl.createEl("div", {
			cls: "setting-item-description",
		});
		shortcutsEl.innerHTML = `
            <ul>
                <li><code>Ctrl+Shift+C</code> - Insert new commentary block</li>
                <li><code>Ctrl+Shift+F</code> - Insert single-line footnote</li>
                <li><code>Ctrl+Alt+F</code> - Insert multi-line footnote</li>
                <li>Use command palette for: Toggle all blocks</li>
            </ul>
        `;

		containerEl.createEl("h3", { text: "Footnote Types & Syntax" });
		const typesEl = containerEl.createEl("div", {
			cls: "setting-item-description",
		});
		typesEl.innerHTML = `
            <p><strong>Single-line footnote:</strong> <code>{{fn:Your text}}</code></p>
            <p><strong>Multi-line footnote:</strong></p>
            <pre>{{fn[[
Your multi-line
footnote text here
]]}}</pre>
            <p><strong>Typed footnotes:</strong></p>
            <ul>
                <li>📝 Note: <code>{{fn:note:Text}}</code></li>
                <li>⚠️ Warning: <code>{{fn:warning:Text}}</code></li>
                <li>ℹ️ Info: <code>{{fn:info:Text}}</code></li>
                <li>📚 Reference: <code>{{fn:reference:Text}}</code></li>
                <li>💡 Idea: <code>{{fn:idea:Text}}</code></li>
                <li>❓ Question: <code>{{fn:question:Text}}</code></li>
            </ul>
        `;
	}
}
