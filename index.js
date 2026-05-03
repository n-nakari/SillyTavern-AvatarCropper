import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

// 初始化当前插件的配置项空间
if (!extension_settings.avatarPosAdjustments) {
    extension_settings.avatarPosAdjustments = {};
}

// 获取不带参数的纯净 Avatar ID（如：Alice.png, User.png）
function getAvatarIdFromSrc(src) {
    try {
        let cleanSrc = src.split('?')[0];
        const parts = cleanSrc.split('/');
        return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
        return src;
    }
}

// 核心函数：动态生成并应用 CSS 样式，覆盖聊天区的头像
function updateAvatarStyles() {
    const theme = localStorage.getItem('theme') || 'default';
    const adjustments = extension_settings.avatarPosAdjustments[theme] || {};

    let cssString = '';
    for (const [avatarId, position] of Object.entries(adjustments)) {
        // 应对可能有空格和特殊字符的情况，生成精确的 CSS 规则
        const escapedId = avatarId.replace(/"/g, '\\"');
        const encodedId = encodeURIComponent(avatarId).replace(/"/g, '\\"');

        // 应用于 #chat 聊天流中，以及右侧头像面板可能显示的地方
        cssString += `
            #chat .avatar img[src*="${escapedId}"],
            #chat .avatar img[src*="${encodedId}"],
            #sheld .avatar img[src*="${escapedId}"],
            #sheld .avatar img[src*="${encodedId}"] {
                object-position: ${position.x}% ${position.y}% !important;
            }
        `;
    }

    let styleTag = document.getElementById('custom-avatar-pos-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'custom-avatar-pos-style';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = cssString;
}

// 检查更换主题 (SillyTavern部分版本没有暴露专门的Theme改变事件，轮询 localStorage 是最轻量稳妥的办法)
let lastTheme = localStorage.getItem('theme');
setInterval(() => {
    const currentTheme = localStorage.getItem('theme');
    if (currentTheme !== lastTheme) {
        lastTheme = currentTheme;
        updateAvatarStyles();
    }
}, 1000);

// ======================== UI 构建与逻辑 ======================== //

let currentEditingAvatarSrc = '';
let currentEditingAvatarId = '';

function buildCropModal() {
    if (document.getElementById('st-avatar-crop-modal')) return;

    const modalHTML = `
        <div id="st-avatar-crop-modal">
            <div class="popup-content">
                <h3>调整头像显示位置</h3>
                <div id="st-avatar-crop-preview-wrapper">
                    <img id="st-avatar-crop-preview-img" src="">
                    <div class="st-avatar-crop-grid"></div>
                </div>
                <div class="st-avatar-crop-controls">
                    <label>左右 (X): <input type="range" id="st-avatar-crop-x" min="0" max="100" value="50"></label>
                    <label>上下 (Y): <input type="range" id="st-avatar-crop-y" min="0" max="100" value="50"></label>
                </div>
                <div class="st-avatar-crop-buttons">
                    <button id="st-avatar-crop-cancel">取消</button>
                    <button id="st-avatar-crop-reset">重置为居中</button>
                    <button id="st-avatar-crop-save">保存应用</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    const previewImg = document.getElementById('st-avatar-crop-preview-img');
    const xSlider = document.getElementById('st-avatar-crop-x');
    const ySlider = document.getElementById('st-avatar-crop-y');

    // 实时预览更新
    const updatePreview = () => {
        previewImg.style.objectPosition = `${xSlider.value}% ${ySlider.value}%`;
    };

    xSlider.addEventListener('input', updatePreview);
    ySlider.addEventListener('input', updatePreview);

    // 拖拽画布逻辑
    let isDragging = false;
    let startMouseX = 0, startMouseY = 0;
    let startPosX = 50, startPosY = 50;

    previewImg.addEventListener('mousedown', (e) => {
        isDragging = true;
        startMouseX = e.clientX;
        startMouseY = e.clientY;
        startPosX = parseFloat(xSlider.value);
        startPosY = parseFloat(ySlider.value);
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        let dx = e.clientX - startMouseX;
        let dy = e.clientY - startMouseY;

        // 乘数 0.5 作为灵敏度。向下滑动鼠标等于想看图片上部，因此 Y 百分比应当减小
        let newX = startPosX - (dx * 0.5);
        let newY = startPosY - (dy * 0.5);

        xSlider.value = Math.max(0, Math.min(100, newX));
        ySlider.value = Math.max(0, Math.min(100, newY));
        updatePreview();
    });

    document.addEventListener('mouseup', () => { isDragging = false; });

    // 按钮事件
    document.getElementById('st-avatar-crop-cancel').addEventListener('click', () => {
        document.getElementById('st-avatar-crop-modal').style.display = 'none';
    });

    document.getElementById('st-avatar-crop-reset').addEventListener('click', () => {
        xSlider.value = 50;
        ySlider.value = 50;
        updatePreview();
    });

    document.getElementById('st-avatar-crop-save').addEventListener('click', () => {
        const theme = localStorage.getItem('theme') || 'default';
        if (!extension_settings.avatarPosAdjustments[theme]) {
            extension_settings.avatarPosAdjustments[theme] = {};
        }

        extension_settings.avatarPosAdjustments[theme][currentEditingAvatarId] = {
            x: parseFloat(xSlider.value),
            y: parseFloat(ySlider.value)
        };
        
        saveSettingsDebounced();
        updateAvatarStyles(); // 立即应用到界面
        document.getElementById('st-avatar-crop-modal').style.display = 'none';
    });
}

function openCropModal(imgSrc) {
    currentEditingAvatarSrc = imgSrc;
    currentEditingAvatarId = getAvatarIdFromSrc(imgSrc);

    const theme = localStorage.getItem('theme') || 'default';
    const savedData = (extension_settings.avatarPosAdjustments[theme] || {})[currentEditingAvatarId] || { x: 50, y: 50 };

    // 获取并套用酒馆当前的头像圆角形状设定，让预览框真实反应聊天窗状态
    const rounding = getComputedStyle(document.body).getPropertyValue('--avatar-rounding') || '50%';
    document.getElementById('st-avatar-crop-preview-wrapper').style.borderRadius = rounding;

    document.getElementById('st-avatar-crop-preview-img').src = currentEditingAvatarSrc;
    document.getElementById('st-avatar-crop-x').value = savedData.x;
    document.getElementById('st-avatar-crop-y').value = savedData.y;
    document.getElementById('st-avatar-crop-preview-img').style.objectPosition = `${savedData.x}% ${savedData.y}%`;

    document.getElementById('st-avatar-crop-modal').style.display = 'flex';
}

function injectCropButton(zoomedDiv) {
    // 避免重复注入
    if (zoomedDiv.querySelector('#st-avatar-crop-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'st-avatar-crop-btn';
    btn.innerHTML = '<i class="fa-solid fa-crop"></i> 位置剪裁';
    btn.title = '调整在聊天框的显示位置（支持拖拽）';

    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // 防止触发点击关闭 zoomed_avatar
        const img = zoomedDiv.querySelector('img');
        if (img) {
            openCropModal(img.src);
        }
    });

    zoomedDiv.appendChild(btn);
}

// 核心加载入口
jQuery(async () => {
    // 首次加载应用现存 CSS
    updateAvatarStyles();

    // 构建设置 UI 模态框
    buildCropModal();

    // 使用 MutationObserver 监听酒馆全屏图片预览 (zoomed_avatar) 出现的时机
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList.contains('zoomed_avatar')) {
                        injectCropButton(node);
                    } else {
                        // 有时候可能是子元素
                        const zoomed = node.querySelector('.zoomed_avatar');
                        if (zoomed) injectCropButton(zoomed);
                    }
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
});
