import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化数据结构: { "ThemeName": { "AvatarID.png": "data:image/png;base64,..." } }
if (!extension_settings.avatarCroppedImages) {
    extension_settings.avatarCroppedImages = {};
}

// 获取酒馆中真正唯一识别的角色/Persona ID (即头像文件名)
function getAvatarIdFromSrc(src) {
    try {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        return src;
    }
}

// 智能获取当前 SillyTavern 正在使用的主题美化名称
function getCurrentTheme() {
    // 现代版本 ST 通常把主题写在 <html> 的 data-theme 属性上
    const htmlTheme = document.documentElement.getAttribute('data-theme');
    if (htmlTheme) return htmlTheme;

    // 兼容部分特定主题扩展或老版本，从 css 链接中提取
    const themeLink = document.querySelector('link[href*="css/themes/"]');
    if (themeLink) {
        const href = themeLink.getAttribute('href');
        const match = href.match(/themes\/(.*?)\.css/);
        if (match) return match[1];
    }

    return 'default';
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

// 核心：根据当前主题，应用保存过的头像。如果没有，则恢复默认。
function applyCroppedAvatars() {
    const currentTheme = getCurrentTheme();
    // 提取当前主题下保存的数据。如果没有，则为空对象 {}
    const croppedData = extension_settings.avatarCroppedImages[currentTheme] || {};

    let cssString = '';
    
    // 如果当前主题下有剪裁数据，则生成针对这些特定 Avatar ID 的替换规则
    for (const [avatarId, base64Image] of Object.entries(croppedData)) {
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');

        // 仅当聊天流中的图片 src 匹配该 Avatar ID 时，才会被替换
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
    
    // 如果 cssString 是空的（例如切换到了一个没保存过头像的主题）
    // textContent 会被清空，浏览器会立刻移除 content: url() 覆盖，恢复原状！
    styleTag.textContent = cssString;
}

// 监听主题变化：通过轮询获取真实 Theme，一旦改变立刻刷新 CSS
let lastTheme = getCurrentTheme();
setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyCroppedAvatars(); // 切换主题时，应用或重置样式
    }
}, 500);

// 调用自带高级剪裁器
async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc);
    const base64Original = await getBase64FromUrl(imgSrc);

    // 呼出剪裁框
    const croppedImageBase64 = await callGenericPopup(
        '', 
        POPUP_TYPE.CROP, 
        '', 
        { cropAspect: 1, cropImage: base64Original }
    );

    // 如果用户保存了剪裁
    if (croppedImageBase64) {
        const currentTheme = getCurrentTheme();
        
        if (!extension_settings.avatarCroppedImages[currentTheme]) {
            extension_settings.avatarCroppedImages[currentTheme] = {};
        }

        // 绑定：Theme -> Avatar ID -> Base64
        extension_settings.avatarCroppedImages[currentTheme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); // 立即应用到界面
        
        toastr.success('头像已保存');
    }
}

// 注入操作按钮
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
            zoomedDiv.click(); // 关闭放大预览图，让路给剪裁弹窗
            await triggerNativeCropPopup(img.src);
        }
    });

    // 插入在控制栏中
    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(btn, closeBtn);
    } else {
        controlBar.appendChild(btn);
    }
}

// 启动入口
jQuery(async () => {
    // 页面加载时执行一次检测和应用
    applyCroppedAvatars();

    // 监听放大图出现
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
