import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
// 引入酒馆自带的弹窗系统，里面内置了 Cropper.js 引擎
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';

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

// 辅助函数：将 URL 图片转换为 Base64，因为自带的剪裁器需要 Base64 输入
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

        // 使用 content: url(...) 直接在 CSS 层面替换 img 标签的显示内容，不会破坏原 DOM 的 src
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

// 轮询检查是否更换了主题，若更换则重新应用对应的剪裁数据
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

    // 调用酒馆内置弹窗：带九宫格、可缩放、支持鼠标拖拽，完美符合你的要求 (cropAspect: 1 强制 1:1 比例)
    const croppedImageBase64 = await callGenericPopup(
        '请调整头像显示部分 (滚轮缩放 / 拖拽移动)', 
        POPUP_TYPE.CROP, 
        '', 
        { cropAspect: 1, cropImage: base64Original }
    );

    // 如果用户点击了确定并返回了剪裁结果
    if (croppedImageBase64) {
        const theme = localStorage.getItem('theme') || 'default';
        if (!extension_settings.avatarCroppedImages[theme]) {
            extension_settings.avatarCroppedImages[theme] = {};
        }

        // 将新的 Base64 绑定到 主题 + 角色ID
        extension_settings.avatarCroppedImages[theme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); // 立即应用
        
        toastr.success('头像剪裁已保存，并与当前主题绑定！');
    }
}

// 注入按钮到放大的头像预览区
function injectCropButton(zoomedDiv) {
    if (zoomedDiv.querySelector('#st-native-crop-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'st-native-crop-btn';
    btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i> 高级剪裁';
    btn.title = '打开高级剪裁器 (支持缩放、九宫格、拖拽)';

    btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // 阻止点击关闭图片预览
        const img = zoomedDiv.querySelector('img');
        if (img) {
            // 点击后，隐藏放大预览框（避免遮挡接下来的剪裁弹窗）
            zoomedDiv.click(); 
            // 触发剪裁
            await triggerNativeCropPopup(img.src);
        }
    });

    zoomedDiv.appendChild(btn);
}

// 初始化
jQuery(async () => {
    // 页面加载时立即应用当前主题的剪裁数据
    applyCroppedAvatars();

    // 监听放大图片出现的动作
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
