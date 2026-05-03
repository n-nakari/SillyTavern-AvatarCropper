import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
// 引入酒馆的斜杠命令系统，用于我们注册清理命令
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';

if (!extension_settings.avatarCroppedImages) {
    extension_settings.avatarCroppedImages = {};
}

function getAvatarIdFromSrc(src) {
    try {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        return src;
    }
}

function getCurrentTheme() {
    const themeSelect = document.getElementById('themes');
    return themeSelect ? themeSelect.value : 'default';
}

async function getBase64FromUrl(url) {
    const data = await fetch(url);
    const blob = await data.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob); 
        reader.onloadend = () => {
            resolve(reader.result);
        }
    });
}

function applyCroppedAvatars() {
    const theme = getCurrentTheme();
    const croppedData = extension_settings.avatarCroppedImages[theme] || {};

    let cssString = '';
    for (const [avatarId, base64Image] of Object.entries(croppedData)) {
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');

        cssString += `
            #chat .avatar img[src*="${escapedId}"],
            #chat .avatar img[src*="${encodedId}"],
            #sheld .avatar img[src*="${escapedId}"],
            #sheld .avatar img[src*="${encodedId}"] {
                content: url("${base64Image}");
                object-fit: cover !important;
            }
        `;
    }

    let styleTag = document.getElementById('custom-avatar-crop-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-avatar-crop-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyCroppedAvatars(); 
    }
}, 1000);

async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc);
    const base64Original = await getBase64FromUrl(imgSrc);

    // 【修改 1】：去掉了 cropAspect: 1，解除了强制 1:1 的锁定，现在可以自由拉伸四条边
    const popupPromise = callGenericPopup(
        '', 
        POPUP_TYPE.CROP, 
        '', 
        { cropImage: base64Original } 
    );

    // 【修改 2】：使用黑科技，在弹窗打开 150 毫秒后，拦截底层的 Cropper 实例并修改配置
    setTimeout(() => {
        const popup = document.getElementById('dialogue_popup');
        if (popup) {
            // 寻找挂载了 cropper 实例的图片节点
            const img = popup.querySelector('img.cropper-hidden');
            if (img && img.cropper) {
                // 强制将拖拽模式改为 'move' (平移画布模式)
                // 这意味着：你在九宫格选区外按住鼠标/手指，会拖拽整张图片，而不是画一个新框！
                img.cropper.setDragMode('move');
            }
        }
    }, 150);

    const croppedImageBase64 = await popupPromise;

    if (croppedImageBase64) {
        const theme = getCurrentTheme(); 
        if (!extension_settings.avatarCroppedImages[theme]) {
            extension_settings.avatarCroppedImages[theme] = {};
        }

        extension_settings.avatarCroppedImages[theme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); 
        toastr.success('头像已保存');
    }
}

function injectCropButton(zoomedDiv) {
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    const btn = document.createElement('div');
    btn.id = 'st-native-crop-btn';
    btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    btn.title = '剪裁头像';

    btn.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        const img = zoomedDiv.querySelector('img');
        if (img) {
            zoomedDiv.click(); 
            await triggerNativeCropPopup(img.src);
        }
    });

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(btn, closeBtn);
    } else {
        controlBar.appendChild(btn);
    }
}

jQuery(async () => {
    applyCroppedAvatars();

    // 【新增功能】：注册清理缓存的斜杠命令
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'crop-clear',
        helpString: '清除当前美化主题下所有的头像剪裁缓存数据，恢复全部默认头像。',
        callback: () => {
            const theme = getCurrentTheme();
            if (extension_settings.avatarCroppedImages && extension_settings.avatarCroppedImages[theme]) {
                delete extension_settings.avatarCroppedImages[theme];
                saveSettingsDebounced();
                applyCroppedAvatars(); // 触发页面更新
                toastr.success(`已清空主题 [${theme}] 下的所有剪裁缓存！`);
            } else {
                toastr.info('当前主题没有剪裁缓存，无需清理。');
            }
            return '';
        }
    }));

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) {
                        injectCropButton(node);
                    } else {
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectCropButton(zoomed);
                    }
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
});
