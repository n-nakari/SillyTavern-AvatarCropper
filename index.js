import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 初始化当前插件的配置项空间，用于存储剪裁后的 Base64 数据
if (!extension_settings.avatarCroppedImages) {
    extension_settings.avatarCroppedImages = {};
}

// 获取独特的代码 ID（提取出精确的文件名，如 Alice.png, 1692123-User.png）
function getAvatarIdFromSrc(src) {
    try {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        return src;
    }
}

// 将 URL 图片转换为 Base64
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

// 核心：精准获取酒馆当前使用的美化主题名字
function getCurrentTheme() {
    // 1. 从酒馆的色彩/UI主题下拉框获取
    const themeSelect = document.getElementById('theme_style');
    if (themeSelect && themeSelect.value) {
        return themeSelect.value;
    }
    // 2. 备用：从 body 的 data-theme 获取
    const dataTheme = document.body.getAttribute('data-theme');
    if (dataTheme) {
        return dataTheme;
    }
    // 3. 兜底
    return 'default_theme';
}

// 核心函数：根据 当前主题 + 角色/用户唯一ID，应用或清除剪裁样式
function applyCroppedAvatars() {
    const currentTheme = getCurrentTheme();
    // 检查是否有绑定在当前主题下的数据，没有则返回空对象
    const croppedData = extension_settings.avatarCroppedImages[currentTheme] || {};

    let cssString = '';
    // 如果该主题下有保存过剪裁，就生成对应的 CSS；如果没有，cssString 为空，自动恢复原生显示！
    for (const [avatarId, base64Image] of Object.entries(croppedData)) {
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');

        // 只对匹配了 ID 的头像使用 content 替换
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
    
    // 如果切换了主题，且新主题下没保存过这个角色的头像，这里的 CSS 会被瞬间清空
    // 浏览器会自动退回到酒馆原生的 <img src="..."> 显示，实现了“恢复默认”的要求。
    styleTag.textContent = cssString;
}

// 实时轮询：如果用户在设置里切换了主题，立刻刷新显示状态
let lastTheme = getCurrentTheme();
setInterval(() => {
    const activeTheme = getCurrentTheme();
    if (activeTheme !== lastTheme) {
        lastTheme = activeTheme;
        applyCroppedAvatars(); // 主题改变，立即重新核对应用规则
    }
}, 800); // 800毫秒轮询，兼顾性能和响应速度

// 调用原生弹窗进行剪裁，并绑定到当前主题和当前角色
async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc); // 获取独立的代码 ID
    const base64Original = await getBase64FromUrl(imgSrc);

    const croppedImageBase64 = await callGenericPopup(
        '', // 不显示标题
        POPUP_TYPE.CROP, 
        '', 
        { cropAspect: 1, cropImage: base64Original }
    );

    if (croppedImageBase64) {
        const currentTheme = getCurrentTheme();
        
        // 确保该主题的对象存在
        if (!extension_settings.avatarCroppedImages[currentTheme]) {
            extension_settings.avatarCroppedImages[currentTheme] = {};
        }

        // 绑定三者：当前主题 -> 角色/Persona 独立ID -> 剪裁图像Base64
        extension_settings.avatarCroppedImages[currentTheme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced(); // 写入酒馆设置文件
        applyCroppedAvatars();   // 瞬间应用新剪裁
        
        toastr.success('头像已保存');
    }
}

// 在放大的预览图片控制栏注入按钮
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
            zoomedDiv.click(); // 关闭预览
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

// 插件入口
jQuery(async () => {
    // 页面启动时应用一次
    applyCroppedAvatars();
    console.log('[AvatarCropper] Successfully bound to Theme system!');

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
