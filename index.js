import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

// 给插件分配一个独立的数据空间，防止与酒馆其他插件冲突
const EXT_NAME = 'st-avatar-cropper';
if (!extension_settings[EXT_NAME]) {
    extension_settings[EXT_NAME] = { avatarCroppedImages: {} };
}

// 提取纯净的 Avatar ID (这正是 SillyTavern 底层区分不同角色/Persona 的唯一代码 ID)
function getAvatarIdFromSrc(src) {
    try {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        return src;
    }
}

// 将网络图片转换为 Base64，供裁剪器读取
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

// 核心：读取当前主题数据，生成 CSS 替换头像
function applyCroppedAvatars() {
    const theme = localStorage.getItem('theme') || 'default';
    
    // 严格匹配：只读取当前“主题”下的数据。如果没有，就获取空对象
    const croppedData = extension_settings[EXT_NAME].avatarCroppedImages[theme] || {};

    let cssString = '';
    // 如果 croppedData 为空，循环不会执行，cssString 为空，头像自动恢复酒馆原生样式
    for (const [avatarId, base64Image] of Object.entries(croppedData)) {
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');

        // 通过 CSS content 直接替换对应的唯一 ID 头像
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
    // 注入 CSS。若切换到无剪裁数据的主题，这里会被覆盖为空，恢复默认样式
    styleTag.textContent = cssString;
}

// 轮询检查主题是否发生切换
let lastTheme = localStorage.getItem('theme');
setInterval(() => {
    const currentTheme = localStorage.getItem('theme');
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        applyCroppedAvatars(); // 检测到切换，立即重新评估样式
    }
}, 1000);

// 触发内置高级裁剪弹窗
async function triggerNativeCropPopup(imgSrc) {
    const avatarId = getAvatarIdFromSrc(imgSrc); // 获取唯一代码 ID
    const base64Original = await getBase64FromUrl(imgSrc);

    // 调用酒馆内置裁剪器。第一个参数设为 '' 去除大标题
    const croppedImageBase64 = await callGenericPopup(
        '', 
        POPUP_TYPE.CROP, 
        '', 
        { cropAspect: 1, cropImage: base64Original }
    );

    // 如果用户点击确定并返回了裁剪图
    if (croppedImageBase64) {
        const theme = localStorage.getItem('theme') || 'default';
        if (!extension_settings[EXT_NAME].avatarCroppedImages[theme]) {
            extension_settings[EXT_NAME].avatarCroppedImages[theme] = {};
        }

        // 完美绑定：主题名称 -> 唯一代码ID -> 裁剪图片
        extension_settings[EXT_NAME].avatarCroppedImages[theme][avatarId] = croppedImageBase64;
        
        saveSettingsDebounced();
        applyCroppedAvatars(); 
        
        toastr.success('头像已保存');
    }
}

// 注入按钮到大图预览的控制栏中
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
            zoomedDiv.click(); // 点击后隐藏放大预览框
            await triggerNativeCropPopup(img.src);
        }
    });

    const closeBtn = controlBar.querySelector('.dragClose');
    if (closeBtn) {
        controlBar.insertBefore(btn, closeBtn); // 插入到关闭按钮的前面
    } else {
        controlBar.appendChild(btn);
    }
}

// 插件启动初始化
jQuery(async () => {
    applyCroppedAvatars();

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
