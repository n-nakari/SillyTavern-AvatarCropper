import { extension_settings, getContext } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const extensionName = 'AvatarCropperMod';
let settings;

// 全局变量保存正在编辑的头像信息
let currentEditingAvatar = {
    filename: '',
    src: '',
    isUser: false
};

// 默认值
const defaultCrop = { z: 1, x: 0, y: 0 };

async function initExtension() {
    // 1. 初始化设置
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = { crops: {} };
    }
    settings = extension_settings[extensionName];

    // 2. 注入全局样式和UI
    updateGlobalCSS();
    injectModalHTML();

    // 3. 挂载各个注入点
    injectCharacterPanelButton();
    setupObservers();
}

/**
 * 核心：动态生成CSS，将保存的剪裁/偏移数据应用到全局所有对应头像上
 */
function updateGlobalCSS() {
    let styleTag = document.getElementById('st-avatar-crop-style');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'st-avatar-crop-style';
        document.head.appendChild(styleTag);
    }

    let css = '';
    for (const [filename, data] of Object.entries(settings.crops)) {
        // 只针对常见的头像元素应用，避免误伤其他图片，并排除了预览框中的图片
        const encodedFilename = encodeURIComponent(filename).replace(/[']/g, "\\'");
        const decodedFilename = decodeURIComponent(filename).replace(/[']/g, "\\'");
        
        // 匹配原始文件名或URL编码后的文件名
        const targetClasses = [
            `.avatar img[src*="${encodedFilename}"]:not(#st-ac-preview)`,
            `.avatar img[src*="${decodedFilename}"]:not(#st-ac-preview)`,
            `.zoomed_avatar[src*="${encodedFilename}"]:not(#st-ac-preview)`,
            `.zoomed_avatar[src*="${decodedFilename}"]:not(#st-ac-preview)`,
            `#avatar_img[src*="${encodedFilename}"]:not(#st-ac-preview)`,
            `#avatar_img[src*="${decodedFilename}"]:not(#st-ac-preview)`,
            `.avatar-container img[src*="${encodedFilename}"]:not(#st-ac-preview)`,
            `.avatar-container img[src*="${decodedFilename}"]:not(#st-ac-preview)`
        ];
        
        css += `${targetClasses.join(', ')} { transform: scale(${data.z}) translate(${data.x}%, ${data.y}%) !important; }\n`;
    }
    styleTag.innerHTML = css;
}

/**
 * 创建用于剪裁的弹窗面板
 */
function injectModalHTML() {
    const modalHTML = `
        <div id="st-ac-modal" class="popup wide_dialog_popup" style="display:none; position:fixed; z-index:99999; top:50%; left:50%; transform:translate(-50%, -50%);">
            <h3><i class="fa-solid fa-crop-simple"></i> 调整头像位置与大小</h3>
            <div class="st-ac-preview-wrapper">
                <img id="st-ac-preview" src="">
            </div>
            
            <div class="st-ac-controls">
                <div class="st-ac-range-row">
                    <label>放大 (Zoom):</label>
                    <input type="range" id="st-ac-z" min="1" max="4" step="0.05" value="1">
                </div>
                <div class="st-ac-range-row">
                    <label>水平 (X轴):</label>
                    <input type="range" id="st-ac-x" min="-50" max="50" step="1" value="0">
                </div>
                <div class="st-ac-range-row">
                    <label>垂直 (Y轴):</label>
                    <input type="range" id="st-ac-y" min="-50" max="50" step="1" value="0">
                </div>
            </div>

            <div class="st-ac-buttons">
                <div id="st-ac-close" class="menu_button menu_button_icon"><i class="fa-solid fa-xmark"></i> 取消</div>
                <div id="st-ac-reset" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate-left"></i> 重置</div>
                <div id="st-ac-save" class="menu_button menu_button_icon"><i class="fa-solid fa-check"></i> 保存全局应用</div>
            </div>
        </div>
        <div id="st-ac-overlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:99998;"></div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // 绑定事件
    const inputs = ['st-ac-z', 'st-ac-x', 'st-ac-y'];
    inputs.forEach(id => {
        document.getElementById(id).addEventListener('input', updatePreview);
    });

    document.getElementById('st-ac-close').addEventListener('click', closeModal);
    document.getElementById('st-ac-overlay').addEventListener('click', closeModal);
    
    document.getElementById('st-ac-reset').addEventListener('click', () => {
        document.getElementById('st-ac-z').value = 1;
        document.getElementById('st-ac-x').value = 0;
        document.getElementById('st-ac-y').value = 0;
        updatePreview();
    });

    document.getElementById('st-ac-save').addEventListener('click', () => {
        const z = parseFloat(document.getElementById('st-ac-z').value);
        const x = parseFloat(document.getElementById('st-ac-x').value);
        const y = parseFloat(document.getElementById('st-ac-y').value);
        
        settings.crops[currentEditingAvatar.filename] = { z, x, y };
        saveSettingsDebounced();
        updateGlobalCSS();
        closeModal();
    });
}

function updatePreview() {
    const z = document.getElementById('st-ac-z').value;
    const x = document.getElementById('st-ac-x').value;
    const y = document.getElementById('st-ac-y').value;
    document.getElementById('st-ac-preview').style.transform = `scale(${z}) translate(${x}%, ${y}%)`;
}

function openModal(filename, src) {
    currentEditingAvatar = { filename, src };
    const data = settings.crops[filename] || defaultCrop;
    
    document.getElementById('st-ac-preview').src = src;
    document.getElementById('st-ac-z').value = data.z;
    document.getElementById('st-ac-x').value = data.x;
    document.getElementById('st-ac-y').value = data.y;
    
    updatePreview();
    
    $('#st-ac-overlay').fadeIn(200);
    $('#st-ac-modal').fadeIn(200);
}

function closeModal() {
    $('#st-ac-overlay').fadeOut(200);
    $('#st-ac-modal').fadeOut(200);
}

/**
 * 注入点 1：角色详情界面 (Avatar Controls)
 */
function injectCharacterPanelButton() {
    // 持续检测面板以确保注入
    const interval = setInterval(() => {
        const target = document.querySelector("#avatar_controls > div");
        if (target && !document.getElementById('st-ac-char-btn')) {
            const btn = document.createElement('div');
            btn.id = 'st-ac-char-btn';
            btn.className = 'menu_button';
            btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i> 调整大小';
            btn.title = "调整此角色的头像大小和位置";
            btn.onclick = () => {
                const context = getContext();
                const charId = context.characterId;
                if (charId === undefined) return;
                const char = context.characters[charId];
                if (!char) return;
                const filename = char.avatar;
                openModal(filename, `/characters/${filename}`);
            };
            target.appendChild(btn);
        }
    }, 1000);
}

/**
 * 设置观察器以处理动态生成的元素 (Zoomed头像 和 User Persona列表)
 */
function setupObservers() {
    // 监听DOM变动
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(m => {
            // 1. 处理聊天栏图片点击放大的注入
            m.addedNodes.forEach(node => {
                if (node.tagName === 'IMG' && node.classList && node.classList.contains('zoomed_avatar')) {
                    injectZoomedAvatarButton(node);
                }
            });
            
            // 2. 处理User Persona列表的注入
            if (document.getElementById('user_avatar_block')) {
                injectPersonaButtons();
            }
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * 注入点 2：点击放大头像后的右上角悬浮按钮
 */
function injectZoomedAvatarButton(imgNode) {
    const btn = document.createElement('div');
    btn.innerHTML = '<i class="fa-solid fa-crop-simple"></i>';
    btn.className = 'menu_button st-ac-floating-btn';
    btn.title = "调整头像";
    
    btn.onclick = (e) => {
        e.stopPropagation(); // 防止点击后触发关闭放大
        const src = imgNode.getAttribute('src');
        const filename = decodeURIComponent(src.split('/').pop());
        openModal(filename, src);
        // 如果想在编辑时关闭原来的放大图片，可以取消下面这行的注释
        // document.body.click(); 
    };
    
    document.body.appendChild(btn);

    // 当图片消失时，也清理掉悬浮按钮
    const removalObserver = new MutationObserver(() => {
        if (!document.body.contains(imgNode)) {
            btn.remove();
            removalObserver.disconnect();
        }
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * 注入点 3：User/Persona 控制面板按钮
 */
function injectPersonaButtons() {
    const blocks = document.querySelectorAll("#user_avatar_block .avatar-container .buttons_block");
    blocks.forEach(block => {
        // 防止重复注入
        if (block.querySelector('.st-ac-persona-btn')) return;
        
        const btn = document.createElement('div');
        btn.className = 'st-ac-persona-btn fa-solid fa-crop-simple';
        btn.title = "调整此Persona的头像显示大小";
        
        btn.onclick = (e) => {
            e.stopPropagation(); 
            const container = block.closest('.avatar-container');
            const filename = container.getAttribute('data-avatar-id');
            // User 头像一般在 "User Avatars" 文件夹下
            const src = `/User Avatars/${filename}`;
            openModal(filename, src);
        };
        
        block.appendChild(btn);
    });
}

// 启动扩展
jQuery(async () => {
    await initExtension();
});
