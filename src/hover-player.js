import { hoverPlayIcon } from "./icons.js";

export function initHoverPlayer(shadow, state, paragraphs, actions) {
	const btn = document.createElement("button");
	btn.className = "hover-player";
	btn.style.display = "none";
	btn.style.pointerEvents = "auto";
	btn.setAttribute("aria-label", "Play from here");

	const icon = hoverPlayIcon();
	icon.style.width = "24px";
	icon.style.height = "24px";
	btn.appendChild(icon);

	shadow.appendChild(btn);

	let currentParagraphIndex = -1;
	let fadeOutTimer = null;
	let hideDelayTimer = null;
	let isOverButton = false;

	function showAt(element, index) {
		if (fadeOutTimer !== null) {
			clearTimeout(fadeOutTimer);
			fadeOutTimer = null;
		}
		if (hideDelayTimer !== null) {
			clearTimeout(hideDelayTimer);
			hideDelayTimer = null;
		}

		currentParagraphIndex = index;

		const rect = element.getBoundingClientRect();
		btn.style.left = `${rect.left - 36}px`;
		btn.style.top = `${rect.top}px`;

		btn.classList.remove("fade-out");
		btn.style.display = "flex";
		void btn.offsetWidth;
	}

	function hide() {
		btn.classList.add("fade-out");
		fadeOutTimer = setTimeout(() => {
			btn.style.display = "none";
			btn.classList.remove("fade-out");
			fadeOutTimer = null;
		}, 200);
	}

	function hideImmediate() {
		if (fadeOutTimer !== null) {
			clearTimeout(fadeOutTimer);
			fadeOutTimer = null;
		}
		if (hideDelayTimer !== null) {
			clearTimeout(hideDelayTimer);
			hideDelayTimer = null;
		}
		btn.style.display = "none";
		btn.classList.remove("fade-out");
	}

	function scheduleHide() {
		if (hideDelayTimer !== null) clearTimeout(hideDelayTimer);
		hideDelayTimer = setTimeout(() => {
			hideDelayTimer = null;
			if (!isOverButton) hide();
		}, 150);
	}

	const boundElements = new WeakSet();

	function bindParagraphs() {
		paragraphs.forEach((para) => {
			const el = para.element;
			if (!el || boundElements.has(el)) return;
			boundElements.add(el);

			el.addEventListener("mouseenter", () => {
				console.log("[Pocket Speechify] Hover paragraph triggered");
				if (hideDelayTimer !== null) {
					clearTimeout(hideDelayTimer);
					hideDelayTimer = null;
				}
				const index = paragraphs.findIndex(
					(paragraph) => paragraph.element === el,
				);
				if (index >= 0) showAt(el, index);
			});

			el.addEventListener("mouseleave", () => {
				console.log("[Pocket Speechify] Hover paragraph leave triggered");
				scheduleHide();
			});
		});
	}

	bindParagraphs();

	btn.addEventListener("mouseenter", () => {
		console.log("[Pocket Speechify] Hover play button hover triggered");
		isOverButton = true;
		if (hideDelayTimer !== null) {
			clearTimeout(hideDelayTimer);
			hideDelayTimer = null;
		}
		if (fadeOutTimer !== null) {
			clearTimeout(fadeOutTimer);
			fadeOutTimer = null;
		}
		btn.classList.remove("fade-out");
		btn.style.display = "flex";
	});

	btn.addEventListener("mouseleave", () => {
		console.log("[Pocket Speechify] Hover play button leave triggered");
		isOverButton = false;
		hide();
	});

	// Click: jump to paragraph — works in any playback state
	btn.addEventListener("click", () => {
		console.log("[Pocket Speechify] Hover play button clicked");
		if (currentParagraphIndex >= 0) {
			hideImmediate();
			actions.play(currentParagraphIndex);
		}
	});

	// On scroll: dismiss immediately
	window.addEventListener(
		"scroll",
		() => {
			console.log("[Pocket Speechify] Hover player scroll triggered");
			hideImmediate();
		},
		{ passive: true, capture: true },
	);

	return { bindParagraphs };
}
