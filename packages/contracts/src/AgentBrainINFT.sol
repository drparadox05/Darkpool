pragma solidity ^0.8.24;

import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract AgentBrainINFT is ERC721URIStorage, ERC2981, Ownable, ReentrancyGuard {
    struct BrainData {
        string metadataHash;
        string encryptedKeyURI;
        uint256 parentTokenId;
    }

    uint96 public constant MAX_ROYALTY_BPS = 1_000;

    uint256 private nextTokenId = 1;

    mapping(uint256 tokenId => BrainData data) public brainData;
    mapping(uint256 tokenId => uint256 fee) public cloneFee;
    mapping(uint256 tokenId => address receiver) public royaltyReceiver;
    mapping(uint256 tokenId => uint96 bps) public royaltyBps;

    event AgentMinted(uint256 indexed tokenId, address indexed owner, string metadataHash, string encryptedKeyURI);
    event AgentCloned(uint256 indexed sourceTokenId, uint256 indexed cloneTokenId, address indexed owner, uint256 cloneFeePaid);
    event BrainUpdated(uint256 indexed tokenId, string metadataHash, string encryptedKeyURI);
    event CloneFeeUpdated(uint256 indexed tokenId, uint256 cloneFee);

    error CloneFeeMismatch(uint256 expected, uint256 actual);
    error RoyaltyTooHigh(uint96 requestedBps, uint96 maxBps);
    error UnauthorizedTokenController(uint256 tokenId, address caller);

    constructor(string memory name_, string memory symbol_, address defaultRoyaltyReceiver, uint96 defaultRoyaltyBps)
        ERC721(name_, symbol_)
        Ownable(msg.sender)
    {
        _validateRoyalty(defaultRoyaltyBps);
        _setDefaultRoyalty(defaultRoyaltyReceiver, defaultRoyaltyBps);
    }

    function mintAgent(
        address to,
        string calldata tokenURI_,
        string calldata metadataHash,
        string calldata encryptedKeyURI,
        uint256 cloneFeeWei,
        address royaltyReceiver_,
        uint96 tokenRoyaltyBps
    ) external returns (uint256 tokenId) {
        _validateRoyalty(tokenRoyaltyBps);

        tokenId = nextTokenId++;
        address receiver = royaltyReceiver_ == address(0) ? to : royaltyReceiver_;

        brainData[tokenId] = BrainData({metadataHash: metadataHash, encryptedKeyURI: encryptedKeyURI, parentTokenId: 0});
        cloneFee[tokenId] = cloneFeeWei;
        royaltyReceiver[tokenId] = receiver;
        royaltyBps[tokenId] = tokenRoyaltyBps;

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, tokenURI_);
        _setTokenRoyalty(tokenId, receiver, tokenRoyaltyBps);

        emit AgentMinted(tokenId, to, metadataHash, encryptedKeyURI);
        emit CloneFeeUpdated(tokenId, cloneFeeWei);
    }

    function cloneAgent(
        uint256 sourceTokenId,
        address to,
        string calldata tokenURI_,
        string calldata metadataHash,
        string calldata encryptedKeyURI
    ) external payable nonReentrant returns (uint256 cloneTokenId) {
        ownerOf(sourceTokenId);
        uint256 requiredFee = cloneFee[sourceTokenId];
        address receiver = royaltyReceiver[sourceTokenId];

        if (msg.value != requiredFee) revert CloneFeeMismatch(requiredFee, msg.value);

        cloneTokenId = nextTokenId++;

        brainData[cloneTokenId] = BrainData({metadataHash: metadataHash, encryptedKeyURI: encryptedKeyURI, parentTokenId: sourceTokenId});
        cloneFee[cloneTokenId] = requiredFee;
        royaltyReceiver[cloneTokenId] = receiver;
        royaltyBps[cloneTokenId] = royaltyBps[sourceTokenId];

        _safeMint(to, cloneTokenId);
        _setTokenURI(cloneTokenId, tokenURI_);
        _setTokenRoyalty(cloneTokenId, receiver, royaltyBps[sourceTokenId]);

        if (requiredFee > 0) {
            (bool paid,) = payable(receiver).call{value: requiredFee}("");
            require(paid, "CLONE_FEE_TRANSFER_FAILED");
        }

        emit AgentCloned(sourceTokenId, cloneTokenId, to, requiredFee);
    }

    function updateBrain(
        uint256 tokenId,
        string calldata tokenURI_,
        string calldata metadataHash,
        string calldata encryptedKeyURI
    ) external {
        _requireTokenController(tokenId);

        brainData[tokenId].metadataHash = metadataHash;
        brainData[tokenId].encryptedKeyURI = encryptedKeyURI;
        _setTokenURI(tokenId, tokenURI_);

        emit BrainUpdated(tokenId, metadataHash, encryptedKeyURI);
    }

    function setCloneFee(uint256 tokenId, uint256 cloneFeeWei) external {
        _requireTokenController(tokenId);

        cloneFee[tokenId] = cloneFeeWei;
        emit CloneFeeUpdated(tokenId, cloneFeeWei);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _requireTokenController(uint256 tokenId) private view {
        address tokenOwner = ownerOf(tokenId);

        if (msg.sender != tokenOwner && getApproved(tokenId) != msg.sender && !isApprovedForAll(tokenOwner, msg.sender)) {
            revert UnauthorizedTokenController(tokenId, msg.sender);
        }
    }

    function _validateRoyalty(uint96 requestedBps) private pure {
        if (requestedBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(requestedBps, MAX_ROYALTY_BPS);
    }
}
