function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerText = "Claude Assistant's extension is currently on. You can turn it off in the Extensions section of Safari Settings.";
        document.getElementsByClassName('state-off')[0].innerText = "Claude Assistant's extension is currently off. You can turn it on in the Extensions section of Safari Settings.";
        document.getElementsByClassName('state-unknown')[0].innerText = "You can turn on Claude Assistant's extension in the Extensions section of Safari Settings.";
        document.getElementsByClassName('open-preferences')[0].innerText = "Quit and Open Safari Settings\u2026";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

// Show or hide the setup status section based on whether the helper script is installed and up-to-date.
// @param {boolean} installed — whether run-claude.sh exists
// @param {boolean} upToDate — whether the script supports extra CLI flags (v2)
function showSetupStatus(installed, upToDate) {
    document.getElementById('setup-needed').style.display = installed ? 'none' : 'block';
    document.getElementById('setup-complete').style.display = installed ? 'block' : 'none';

    // Show update notice if script exists but is outdated (missing v2 shift 3 support)
    const updateNotice = document.getElementById('update-needed');
    if (updateNotice) {
        updateNotice.style.display = (installed && !upToDate) ? 'block' : 'none';
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

function installScript() {
    webkit.messageHandlers.controller.postMessage("install-script");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
document.getElementById("install-script").addEventListener("click", installScript);
document.getElementById("reinstall-script").addEventListener("click", installScript);
document.getElementById("update-script").addEventListener("click", installScript);
