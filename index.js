import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化当前插件的配置项空间，用于存储剪裁后的 Base64 数据
if (!extension_settings.avatarCroppedImages) {
    extension_settings.avatarCroppedImages = {};
}

// 辅助函数：从 URL 提取纯净的 Avatar ID（如：Alice.png, User.png）
function getAvatarIdFromSrc(src) {
    try {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        return src;
    }
}

// 辅助函数：将 URL 图片转换为 Base64
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

// 核心函数：动态生成 CSS，使用 content 属性在视觉上替换图片
function applyCroppedAvatars() {
    const theme = localStorage.getItem('theme') || 'default';
    const croppedData = extension_settings.avatarCroppedImages[theme] || {};

    let cssString = '';
    for (const [avatarId, base64Image] of Object.entries(croppedData)) {
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');

        // 使用 content: url(...) 在视觉上替换 img 标签的显示内容
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

// 轮询检查是否更换了主题
let lastTheme = localStorage.getItem('theme');
setInterval(() => {
    const currentTheme = localStorage.getItem('theme');
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyCroppedAvatars();
    }
}, 1000);

// 调用酒馆内置的 Cropper.js 弹窗
async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc);
    
    // 转换为 Base64
    const base64Original = await getBase64FromUrl(imgSrc);

    // 呼出剪裁器
    const croppedImageBase64 = await callGenericPopup(
        '请调整头像显示部分 (滚轮缩放 / 拖拽移动)', 
        POPUP_TYPE.CROP, 
        '', 
        { cropAspect: 1, cropImage: base64Original }
    );

    if (croppedImageBase64) {
        const theme = localStorage.getItem('theme') || 'default';
        if (!extension_settings.avatarCroppedImages[theme]) {
            extension_settings.avatarCroppedImages[theme] = {};
        }

        extension_settings.avatarCroppedImages[theme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); 
        
        toastr.success('头像已保存');
    }
}

// 将按钮注入到顶部控制栏
function injectCropButton(zoomedDiv) {
    // 寻找控制栏
    const controlBar = zoomedDiv.querySelector('.panelControlBar');
    if (!controlBar) return;

    if (controlBar.querySelector('#st-native-crop-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'st-native-crop-btn';
    // 仅保留图标
    btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    btn.title = '剪裁头像';

    btn.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        const img = zoomedDiv.querySelector('img');
        if (img) {
            // 点击后，触发原生关闭按钮以隐藏预览层
            const closeBtn = controlBar.querySelector('.dragClose');
            if (closeBtn) closeBtn.click();
            else zoomedDiv.click();

            // 触发剪裁
            await triggerNativeCropPopup(img.src);
        }
    });

    // 把它插入到“关闭按钮 (.dragClose)”的前面
    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(btn, closeBtn);
    } else {
        controlBar.appendChild(btn);
    }
}

// 初始化
jQuery(async () => {
    applyCroppedAvatars();
    console.log('[AvatarCropper] UI Integrated Extension Loaded!');

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
