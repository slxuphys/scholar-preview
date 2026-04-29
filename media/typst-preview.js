(function () {
  const vscode = acquireVsCodeApi();
  const viewer = document.getElementById("viewer");
  const statusText = document.getElementById("statusText");
  const toolbar = document.querySelector(".toolbar");

  document.getElementById("recompileBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "recompile" });
  });

  document.getElementById("exportPdfBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "exportPdf" });
  });

  document.getElementById("downloadTypBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "downloadTyp" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "compiling":
        // Show subtle indicator without touching page content
        statusText.textContent = "Compiling…";
        toolbar.classList.add("compiling");
        break;

      case "showPages":
        toolbar.classList.remove("compiling");
        statusText.textContent =
          msg.pages.length + " page" + (msg.pages.length !== 1 ? "s" : "");
        updatePages(msg.pages);
        break;

      case "error":
        toolbar.classList.remove("compiling");
        statusText.textContent = "Error";
        // Show error below existing pages so layout doesn't jump
        let errDiv = viewer.querySelector(".error");
        if (!errDiv) {
          errDiv = document.createElement("div");
          errDiv.className = "error";
          viewer.appendChild(errDiv);
        }
        errDiv.innerHTML = `<pre>${escHtml(msg.message)}</pre>`;
        break;

      case "empty":
        toolbar.classList.remove("compiling");
        statusText.textContent = "";
        viewer.innerHTML =
          '<div class="empty">Open a notebook or Markdown file to preview.</div>';
        break;
    }
  });

  /** Update page images in-place to avoid blink.
   *  - Same page count: swap src on existing <img> elements.
   *  - Fewer pages: update existing ones, remove extras.
   *  - More pages: update existing ones, append new ones. */
  function updatePages(srcs) {
    // Remove any error overlay now that we have fresh pages
    const errDiv = viewer.querySelector(".error");
    if (errDiv) { errDiv.remove(); }

    const existing = viewer.querySelectorAll(".page");

    for (let i = 0; i < srcs.length; i++) {
      if (i < existing.length) {
        // Update src in-place — browser swaps the image without layout thrash
        existing[i].querySelector("img").src = srcs[i];
      } else {
        const div = document.createElement("div");
        div.className = "page";
        const img = document.createElement("img");
        img.alt = "Page";
        img.draggable = false;
        img.src = srcs[i];
        div.appendChild(img);
        viewer.appendChild(div);
      }
    }

    // Remove surplus pages (document got shorter)
    for (let i = srcs.length; i < existing.length; i++) {
      existing[i].remove();
    }
  }

  function escHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
})();
